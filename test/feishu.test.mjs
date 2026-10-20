import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FEISHU_HINT,
  channelList,
  composeMessage,
  connectFeishu,
  decodeFrame,
  dialogFingerprint,
  encodeFrame,
  feishuCard,
  feishuRegistrationWait,
  mergeFragments,
  remoteChannels,
} from "../src/lib/index.mjs";
import { feishuMessageText, handleFeishuEvent } from "../src/inbound/feishu.mjs";
import { rememberOutbound } from "../src/inbound/reply.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("a frame encodes to the bytes protobuf would write", () => {
  const bytes = encodeFrame({
    SeqID: 1n,
    LogID: 2n,
    service: 3,
    method: 1,
    headers: [{ key: "type", value: "event" }],
  });
  const expected = [0x08, 0x01, 0x10, 0x02, 0x18, 0x03, 0x20, 0x01, 0x2a, 0x0d, 0x0a, 0x04];
  expected.push(...encoder.encode("type"), 0x12, 0x05, ...encoder.encode("event"));
  assert.deepEqual([...bytes], expected);
});

test("a frame survives a round trip, uint64 ids past 2^53 included", () => {
  const frame = {
    SeqID: 7n,
    LogID: 2n ** 63n + 5n,
    service: 42,
    method: 1,
    headers: [
      { key: "type", value: "event" },
      { key: "message_id", value: "m-1" },
    ],
    payload: encoder.encode('{"hello":"世界"}'),
    LogIDNew: "log-new",
  };
  const back = decodeFrame(encodeFrame(frame));
  assert.equal(back.SeqID, 7n);
  assert.equal(back.LogID, 2n ** 63n + 5n);
  assert.equal(back.service, 42);
  assert.equal(back.method, 1);
  assert.deepEqual(back.headers, frame.headers);
  assert.equal(decoder.decode(back.payload), '{"hello":"世界"}');
  assert.equal(back.LogIDNew, "log-new");
});

test("a split event is handed over only once every piece is in", () => {
  const store = new Map();
  const head = { message_id: "m", sum: "2", seq: "1" };
  assert.equal(mergeFragments(store, head, encoder.encode("world"), 0), undefined);
  const whole = mergeFragments(store, { ...head, seq: "0" }, encoder.encode("hello "), 0);
  assert.equal(decoder.decode(whole), "hello world");
  assert.equal(store.size, 0);
  const single = encoder.encode("x");
  assert.equal(mergeFragments(store, { message_id: "n" }, single), single);
});

// Feishu as a script of responses, recording which host each poll went to.
function scriptedFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, body: String(init?.body ?? "") });
    const next = responses.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
}

test("registration waits out pending and slow_down, and follows a Lark tenant once", async () => {
  const calls = [];
  const waits = [];
  const result = await feishuRegistrationWait({
    deviceCode: "dc",
    interval: 5,
    expiresAt: Number.MAX_SAFE_INTEGER,
    wait: async (ms) => waits.push(ms),
    fetchImpl: scriptedFetch(
      [
        { error: "authorization_pending" },
        { error: "slow_down" },
        { error: "authorization_pending", user_info: { tenant_brand: "lark" } },
        { client_id: "cli_1", client_secret: "s3", user_info: { open_id: "ou_me", tenant_brand: "lark" } },
      ],
      calls,
    ),
  });
  assert.deepEqual(result, { kind: "paired", appId: "cli_1", appSecret: "s3", openId: "ou_me", brand: "lark" });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).host),
    ["accounts.feishu.cn", "accounts.feishu.cn", "accounts.feishu.cn", "accounts.larksuite.com"],
  );
  assert.ok(calls.every((call) => call.body === "action=poll&device_code=dc"));
  // The first poll and the brand switch are immediate; slow_down adds 5 s.
  assert.deepEqual(waits, [5000, 10000]);
});

test("registration ends on a refusal, an expiry, or a newer scan", async () => {
  const denied = await feishuRegistrationWait({
    deviceCode: "dc",
    expiresAt: Number.MAX_SAFE_INTEGER,
    wait: async () => {},
    fetchImpl: scriptedFetch([{ error: "access_denied" }], []),
  });
  assert.deepEqual(denied, { kind: "denied" });

  const calls = [];
  const expired = await feishuRegistrationWait({
    deviceCode: "dc",
    expiresAt: 10,
    now: () => 11,
    fetchImpl: scriptedFetch([], calls),
  });
  assert.deepEqual(expired, { kind: "expired" });
  assert.equal(calls.length, 0);

  const cancelled = await feishuRegistrationWait({
    deviceCode: "dc",
    expiresAt: Number.MAX_SAFE_INTEGER,
    wanted: () => false,
    fetchImpl: scriptedFetch([], []),
  });
  assert.deepEqual(cancelled, { kind: "cancelled" });
});

test("a card puts each choice on a button that sends its key, and a note replaces them", () => {
  const options = [
    { key: "1", send: "1", label: "Yes" },
    { key: "2", send: "esc", label: "No, and tell Claude what to do differently (esc)" },
  ];
  const text = composeMessage("blocked · Claude", "repo · main", "blocked", "Do you want to proceed?");
  const card = feishuCard({ text, options });
  assert.equal(card.schema, "2.0");
  const [body, ...buttons] = card.body.elements;
  // Telegram's hint is reworded for Feishu, where typing an answer means quoting.
  assert.deepEqual(body.text, {
    tag: "plain_text",
    content: `blocked · Claude\nrepo · main\n\nDo you want to proceed?\n\n${FEISHU_HINT}`,
  });
  assert.deepEqual(
    buttons.map((button) => [button.text.content, button.behaviors[0].value.send]),
    [
      ["1. Yes", "1"],
      ["2. No, and tell Claude what to do differently (esc)", "esc"],
    ],
  );
  assert.ok(!/\p{Extended_Pictographic}/u.test(JSON.stringify(card)), "plain text, no emoji");

  const pressed = feishuCard({ text, options, note: "1. Yes\nsent · repo" });
  assert.deepEqual(
    pressed.body.elements.map((element) => element.tag),
    ["div", "div"],
    "no buttons left to press",
  );
  assert.equal(
    pressed.body.elements[0].text.content,
    "blocked · Claude\nrepo · main\n\nDo you want to proceed?",
    "and no hint about pressing them",
  );
});

test("CHANNEL picks among paired channels, telegram when unset", () => {
  assert.deepEqual(channelList(undefined), ["telegram"]);
  assert.deepEqual(channelList(" Feishu , telegram,bogus,feishu"), ["feishu", "telegram"]);
  const feishu = { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "s", FEISHU_OPEN_ID: "ou" };
  const telegram = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" };
  assert.deepEqual(remoteChannels({ ...feishu, ...telegram, CHANNEL: "feishu" }), ["feishu"]);
  assert.deepEqual(remoteChannels({ ...feishu, ...telegram, CHANNEL: "telegram,feishu" }), ["telegram", "feishu"]);
  // Selected but not paired is not a channel.
  assert.deepEqual(remoteChannels({ ...telegram, CHANNEL: "feishu" }), []);
  assert.deepEqual(remoteChannels({ ...feishu, FEISHU_OPEN_ID: "", CHANNEL: "feishu" }), []);
});

test("a message's text loses its mention placeholders", () => {
  const text = (content) => feishuMessageText({ message_type: "text", content: JSON.stringify(content) });
  assert.equal(text({ text: "@_user_1 yes please" }), "yes please");
  assert.equal(feishuMessageText({ message_type: "image", content: "{}" }), "");
  assert.equal(feishuMessageText({ message_type: "text", content: "not json" }), "");
});

const DIALOG = [
  "⏺ Bash(rm -rf -- /tmp/draft)",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "  Esc to cancel · Tab to amend",
].join("\n");

const MOVED_ON = ["⏺ removed /tmp/draft.", "", "❯", "  ➜ repo git:(main) ctx:20% Opus 5"].join("\n");

const WORKING = "⏺ Bash(rm -rf -- /tmp/draft)\n  ⎿  Running…\n\n✢ Working… (3s · esc to interrupt)";

async function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-feishu-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// A pane whose screen moves on once a key lands, and herdr as a recorder.
function paneRun({ before, after = before, statusBefore = "idle", statusAfter = statusBefore, calls }) {
  let answered = false;
  return (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      const status = answered ? statusAfter : statusBefore;
      return { status: 0, stdout: JSON.stringify({ result: { agent_status: status } }) };
    }
    if (args[1] === "read") {
      const text = answered ? after : before;
      return { status: 0, stdout: JSON.stringify({ result: { read: { text } } }) };
    }
    if (args[1] === "send-keys" || args[1] === "prompt") {
      answered = true;
    }
    return { status: 0, stdout: "" };
  };
}

function feishuDeps(run, sent, extra = {}) {
  return {
    creds: { appId: "cli_1", appSecret: "s", brand: "feishu" },
    openId: "ou_me",
    seen: new Map(),
    run,
    wait: async () => {},
    send: async (_creds, _openId, text, options = {}) => {
      sent.push({ text, options: options.options });
      return `om_${sent.length + 100}`;
    },
    ...extra,
  };
}

function messageEvent(text, { parent, sender = "ou_me", id = "ev1" } = {}) {
  return {
    header: { event_id: id, event_type: "im.message.receive_v1", app_id: "cli_1" },
    event: {
      sender: { sender_id: { open_id: sender } },
      message: {
        message_id: "om_in",
        parent_id: parent,
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
  };
}

function rememberDialogPing() {
  rememberOutbound({
    messageId: "om_7",
    paneId: "w8:p1",
    status: "blocked",
    where: "asr-service · main",
    title: "blocked · Claude",
    fingerprint: dialogFingerprint(DIALOG),
    options: [
      { key: "1", send: "1", label: "Yes" },
      { key: "2", send: "2", label: "No" },
    ],
    channel: "feishu",
    text: "blocked · Claude\nasr-service · main\n\nDo you want to proceed?",
  });
}

test("a quoted reply is bound to its dialog, a bare message is not", async () => {
  await withStateDir(async () => {
    rememberDialogPing();

    const calls = [];
    const sent = [];
    const quoted = handleFeishuEvent(
      messageEvent("1", { parent: "om_7" }),
      feishuDeps(paneRun({ before: MOVED_ON, calls }), sent),
    );
    const stale = await quoted.work();
    assert.equal(stale.stale, true);
    assert.deepEqual(sent.map((message) => message.text), ["stale · asr-service · main · dialog changed, not sent"]);
    assert.ok(!calls.some((call) => call.includes("send-keys") || call.includes("agent prompt")));

    const bareCalls = [];
    const bareSent = [];
    const bare = handleFeishuEvent(
      messageEvent("start the next task", { id: "ev2" }),
      feishuDeps(paneRun({ before: MOVED_ON, calls: bareCalls }), bareSent),
    );
    const delivered = await bare.work();
    assert.equal(delivered.ok, true);
    assert.equal(bareCalls.at(-1), "agent prompt w8:p1 start the next task");
    assert.match(bareSent.at(-1).text, /^sent · asr-service · main$/);
  });
});

test("only the paired user, in a direct chat, reaches a pane, and only once per event", async () => {
  await withStateDir(async () => {
    rememberDialogPing();
    const calls = [];
    const deps = feishuDeps(paneRun({ before: DIALOG, calls }), []);
    assert.deepEqual(handleFeishuEvent(messageEvent("1", { sender: "ou_someone" }), deps), { skipped: "sender" });

    const group = messageEvent("1", { id: "ev-group" });
    group.event.message.chat_type = "group";
    assert.deepEqual(handleFeishuEvent(group, deps), { skipped: "chat" });

    const otherApp = messageEvent("1", { id: "ev-app" });
    otherApp.header.app_id = "cli_other";
    assert.deepEqual(handleFeishuEvent(otherApp, deps), { skipped: "app" });

    const first = handleFeishuEvent(messageEvent("1", { id: "ev-dup" }), deps);
    assert.equal(typeof first.work, "function");
    assert.deepEqual(handleFeishuEvent(messageEvent("1", { id: "ev-dup" }), deps), { skipped: "duplicate" });
    assert.deepEqual(calls, [], "nothing reached herdr while deciding");
  });
});

function cardTap({ messageId = "om_7", send = "1", operator = "ou_me", id = "ev-card" } = {}) {
  return {
    header: { event_id: id, event_type: "card.action.trigger", app_id: "cli_1" },
    event: {
      operator: { open_id: operator },
      action: { tag: "button", value: { send } },
      context: { open_message_id: messageId, open_chat_id: "oc_1" },
    },
  };
}

test("a card tap answers at once with the buttons gone, then says what happened", async () => {
  await withStateDir(async () => {
    rememberDialogPing();
    const calls = [];
    const sent = [];
    const updates = [];
    const outcome = handleFeishuEvent(
      cardTap(),
      feishuDeps(
        paneRun({ before: DIALOG, after: WORKING, statusBefore: "blocked", statusAfter: "working", calls }),
        sent,
        {
          updateCard: async (_creds, messageId, card) => updates.push({ messageId, card }),
        },
      ),
    );
    assert.equal(outcome.response.toast.type, "info");
    const immediate = outcome.response.card.data.body.elements;
    assert.ok(!immediate.some((element) => element.tag === "button"), "the card cannot be pressed twice");
    assert.equal(immediate.at(-1).text.content, "1. Yes\nsending");
    assert.equal(calls.length, 0, "the keypress waits for the queued work");

    const result = await outcome.work();
    assert.equal(result.ok, true);
    assert.ok(calls.includes("pane send-keys w8:p1 1"), calls.join("\n"));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].messageId, "om_7");
    assert.equal(updates[0].card.body.elements.at(-1).text.content, "1. Yes\nsent · asr-service · main");
    assert.equal(
      updates[0].card.body.elements[0].text.content,
      "blocked · Claude\nasr-service · main\n\nDo you want to proceed?",
    );
    assert.deepEqual(sent, [], "the card itself is the ack");
  });
});

test("a tap on an unknown card, or by someone else, presses nothing", async () => {
  await withStateDir(async () => {
    rememberDialogPing();
    const calls = [];
    const deps = feishuDeps(paneRun({ before: DIALOG, calls }), []);
    const unknown = handleFeishuEvent(cardTap({ messageId: "om_999" }), deps);
    assert.equal(unknown.skipped, "no-target");
    assert.equal(unknown.work, undefined);
    assert.equal(unknown.response.toast.type, "error");

    const stranger = handleFeishuEvent(cardTap({ operator: "ou_someone", id: "ev-2" }), deps);
    assert.equal(stranger.skipped, "sender");
    assert.equal(stranger.work, undefined);
    assert.deepEqual(calls, []);
  });
});

test("a failed card update falls back to a message", async () => {
  await withStateDir(async () => {
    rememberDialogPing();
    const calls = [];
    const sent = [];
    const outcome = handleFeishuEvent(
      cardTap(),
      feishuDeps(
        paneRun({ before: DIALOG, after: WORKING, statusBefore: "blocked", statusAfter: "working", calls }),
        sent,
        {
          updateCard: async () => {
            throw new Error("no permission");
          },
        },
      ),
    );
    await outcome.work();
    assert.deepEqual(sent.map((message) => message.text), ["sent · asr-service · main"]);
  });
});

// The browser WebSocket API, enough of it to drive one connection by hand.
class FakeSocket {
  static last;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }

  send(bytes) {
    this.sent.push(decodeFrame(bytes));
  }

  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }
}

function endpointFetch() {
  return async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        code: 0,
        data: { URL: "wss://ws.example.test/ws?device_id=d1&service_id=7", ClientConfig: { PingInterval: 90 } },
      }),
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("the long connection pings, hands events over, and acks with the handler's result", async () => {
  const events = [];
  const closed = connectFeishu({
    creds: { appId: "cli_1", appSecret: "s", brand: "feishu" },
    onEvent: (envelope) => {
      events.push(envelope);
      return { toast: { type: "info", content: "sending" } };
    },
    WebSocketImpl: FakeSocket,
    fetchImpl: endpointFetch(),
    log: { log() {}, error() {} },
    checkMs: 1_000_000,
  });
  await settle();
  const socket = FakeSocket.last;
  assert.equal(socket.url, "wss://ws.example.test/ws?device_id=d1&service_id=7");
  const [ping] = socket.sent;
  assert.equal(ping.method, 0);
  assert.equal(ping.service, 7);
  assert.deepEqual(ping.headers, [{ key: "type", value: "ping" }]);

  const envelope = { header: { event_id: "e1", event_type: "card.action.trigger" }, event: {} };
  const frame = {
    SeqID: 3n,
    LogID: 2n ** 60n,
    service: 7,
    method: 1,
    headers: [
      { key: "type", value: "event" },
      { key: "message_id", value: "m1" },
      { key: "sum", value: "1" },
      { key: "seq", value: "0" },
    ],
    payload: encoder.encode(JSON.stringify(envelope)),
  };
  const bytes = encodeFrame(frame);
  socket.emit("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  await settle();

  assert.deepEqual(events, [envelope]);
  const ack = socket.sent.at(-1);
  assert.equal(ack.method, 1);
  assert.equal(ack.LogID, 2n ** 60n, "the ack names the frame it answers");
  assert.ok(ack.headers.some((header) => header.key === "biz_rt"));
  const body = JSON.parse(decoder.decode(ack.payload));
  assert.equal(body.code, 200);
  assert.deepEqual(JSON.parse(Buffer.from(body.data, "base64").toString("utf8")), {
    toast: { type: "info", content: "sending" },
  });

  socket.close();
  assert.equal(await closed, "closed 1000");
});

test("a handler that throws is acked as a failure, not left hanging", async () => {
  const closed = connectFeishu({
    creds: { appId: "cli_1", appSecret: "s", brand: "feishu" },
    onEvent: () => {
      throw new Error("boom");
    },
    WebSocketImpl: FakeSocket,
    fetchImpl: endpointFetch(),
    log: { log() {}, error() {} },
    checkMs: 1_000_000,
  });
  await settle();
  const socket = FakeSocket.last;
  const bytes = encodeFrame({
    SeqID: 1n,
    LogID: 1n,
    service: 7,
    method: 1,
    headers: [{ key: "type", value: "event" }],
    payload: encoder.encode("{}"),
  });
  socket.emit("message", { data: bytes });
  await settle();
  assert.equal(JSON.parse(decoder.decode(socket.sent.at(-1).payload)).code, 500);
  socket.close();
  await closed;
});
