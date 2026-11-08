import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callState, dialogFingerprint, screenHasLiveDialog } from "../src/lib/index.mjs";
import { alreadyShown, deliverReply, lookupOutbound, markOutbound, rememberOutbound, staleDialog } from "../src/inbound/reply.mjs";
import { handleFeishuEvent } from "../src/inbound/feishu.mjs";
import { armEscalation, checkEscalations, readEscalations } from "../src/inbound/escalation.mjs";
import { roleSettings } from "../src/lib/index.mjs";

// Claude Code 2.1.319's WebFetch dialog, as a probe drew it (herdr pane read
// --source visible), at its full width and after the pane was narrowed: the
// question re-wraps, and the fingerprint with it. The dialog is the same one.
const WIDE = [
  "⏺ Fetch(https://example.org)",
  "",
  "──────────────────────────────────────────────────────────────────────",
  " Fetch",
  " Claude wants to fetch content from example.org",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " url: https://example.org/",
  " prompt: What is the page title? Return only the title text.",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " Do you want to allow Claude to fetch this content?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for example.org",
  "   3. No, and tell Claude what to do differently (esc)",
].join("\n");
const NARROW = [
  "⏺ Fetch(https://example.org)",
  "",
  "───────────────────────────────────",
  " Fetch",
  " Claude wants to fetch content",
  " from example.org",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " url: https://example.org/",
  " prompt: What is the page title?",
  " Return only the title text.",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " Do you want to allow Claude to",
  " fetch this content?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for",
  "      example.org",
  "   3. No, and tell Claude what to",
  "      do differently (esc)",
].join("\n");
// A different dialog: another call.
const OTHER = WIDE.replaceAll("example.org", "example.net");
// The dialog answered: the tool ran, the prompt box is back.
const ANSWERED = ["⏺ Fetch(https://example.org)", "  ⎿  Received 1.2KB (200 OK)", "", "⏺ The title is Example Domain.", "", "────────", "❯ ", "────────"].join("\n");

const CALL = { agent: "claude", file: "/nowhere.jsonl", id: "toolu_01AbCdEf7sH6wA", name: "WebFetch", asks: false };
const OTHER_CALL = { ...CALL, id: "toolu_01Other0000000" };

test("the premise: one dialog, two fingerprints", () => {
  assert.equal(screenHasLiveDialog(WIDE), true);
  assert.equal(screenHasLiveDialog(NARROW), true);
  assert.notEqual(dialogFingerprint(WIDE), dialogFingerprint(NARROW));
});

// staleDialog with every edge given: what is on screen, the call's state, and
// which call the screen's dialog is about (null: none can be named).
function judge(screen, { call = CALL, state = "open", onScreen = CALL, fingerprint = dialogFingerprint(WIDE) } = {}) {
  return staleDialog("w1Z:p1", "blocked", fingerprint, {
    call: call ?? undefined,
    readScreen: () => screen,
    callState: () => state,
    screenCall: () => onScreen ?? undefined,
  });
}

test("the same open call is the same dialog however it is redrawn", () => {
  assert.equal(judge(NARROW), undefined);
  // Which call the screen shows cannot be told: the fingerprint decides.
  assert.equal(judge(WIDE, { onScreen: null }), undefined);
  assert.equal(judge(NARROW, { onScreen: null }).reason, "changed");
});

test("a call that has its result is answered: changed with a dialog up, gone without", () => {
  assert.deepEqual(
    { ...judge(WIDE, { state: "answered" }), screen: undefined },
    { status: 1, stale: true, reason: "changed", screen: undefined, stderr: "dialog changed since this ping" },
  );
  assert.equal(judge(ANSWERED, { state: "answered" }).reason, "gone");
  // Still open, but its dialog is no longer drawn (approved, still running).
  assert.equal(judge(ANSWERED, { state: "open" }).reason, "gone");
  // Open, and the dialog on screen is another call's.
  assert.equal(judge(OTHER, { onScreen: OTHER_CALL }).reason, "changed");
});

test("no call to go by, or a form: the fingerprint decides, as before", () => {
  assert.equal(judge(WIDE, { call: null }), undefined);
  assert.equal(judge(NARROW, { call: null }).reason, "changed");
  assert.equal(judge(NARROW, { state: "unknown" }).reason, "changed");
  const form = { ...CALL, asks: true };
  assert.equal(judge(NARROW, { call: form }).reason, "changed");
  assert.equal(judge(WIDE, { call: form }), undefined);
});

test("a tap on a redrawn dialog of the same open call presses the key", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { pane: { agent_status: "blocked" } } }) };
    }
    if (args[1] === "read") {
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: NARROW } } }) };
    }
    return { status: 0, stdout: "" };
  };
  const result = deliverReply("w1Z:p1", "1", "blocked", {
    fingerprint: dialogFingerprint(WIDE),
    call: CALL,
    run,
    callState: () => "open",
    screenCall: () => CALL,
  });
  assert.equal(result.status, 0);
  assert.ok(calls.includes("pane send-keys w1Z:p1 1"));
});

// ---------------------------------------------------------------------------
// The session record decides "open": a call with no result yet.

function withDir(body) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-call-"));
    const previous = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
    try {
      await body(dir);
    } finally {
      if (previous === undefined) {
        delete process.env.HERDR_PLUGIN_STATE_DIR;
      } else {
        process.env.HERDR_PLUGIN_STATE_DIR = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const lines = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

test(
  "callState reads the record: open until the call's result is written",
  withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    const use = { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: CALL.id, name: "WebFetch", input: {} }] } };
    const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: CALL.id, content: "ok" }] } };
    const monitor = { type: "user", message: { content: "<task-notification>orch-x</task-notification>" } };
    writeFileSync(file, lines([use, monitor]));
    assert.equal(callState({ ...CALL, file }), "open");
    writeFileSync(file, lines([use, monitor, result]));
    assert.equal(callState({ ...CALL, file }), "answered");
    assert.equal(callState({ ...CALL, file, id: "toolu_missing" }), "unknown");
    assert.equal(callState({ ...CALL, file: join(dir, "gone.jsonl") }), "unknown");

    const codexFile = join(dir, "rollout.jsonl");
    const codexCall = { agent: "codex", file: codexFile, id: "call_9" };
    const fn = { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call_9", arguments: "{}" } };
    writeFileSync(codexFile, lines([fn]));
    assert.equal(callState(codexCall), "open");
    writeFileSync(codexFile, lines([fn, { type: "response_item", payload: { type: "function_call_output", call_id: "call_9", output: "ok" } }]));
    assert.equal(callState(codexCall), "answered");
  }),
);

// ---------------------------------------------------------------------------
// The user always has a card to press.

function feishuWorld(screen) {
  const sent = [];
  const updates = [];
  const calls = [];
  let current = screen;
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { pane: { agent_status: "blocked" } } }) };
    }
    if (args[1] === "read") {
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: current } } }) };
    }
    if (args[1] === "send-keys" || args[1] === "send-text") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  const deps = (extra = {}) => ({
    creds: { appId: "cli_1", appSecret: "s", brand: "feishu" },
    openId: "ou_me",
    seen: new Map(),
    run,
    wait: async () => {},
    send: async (_creds, _openId, text, options = {}) => {
      sent.push({ text, buttons: (options.options ?? []).map((option) => option.send) });
      return `om_new_${sent.length}`;
    },
    updateCard: async (_creds, messageId, card) => {
      updates.push({ messageId, note: card.body.elements.at(-1).text.content });
    },
    ...extra,
  });
  return { sent, updates, calls, deps, setScreen: (text) => (current = text) };
}

let tapCount = 0;
function tap(messageId, send = "1") {
  tapCount++;
  return {
    header: { event_id: `ev-call-${tapCount}`, event_type: "card.action.trigger", app_id: "cli_1" },
    event: { operator: { open_id: "ou_me" }, action: { value: { send } }, context: { open_message_id: messageId } },
  };
}

function card(messageId, screen, call = CALL) {
  rememberOutbound({
    messageId,
    paneId: "w1Z:p1",
    status: "blocked",
    where: "Git-Repo · pane 1",
    title: "主会话在等你确认",
    fingerprint: dialogFingerprint(screen),
    options: [
      { key: "1", send: "1", label: "Yes" },
      { key: "2", send: "2", label: "Yes, and don't ask again for example.org" },
    ],
    channel: "feishu",
    text: "主会话在等你确认\n\nWebFetch · https://example.org",
    layout: "main",
    call,
  });
}

test(
  "the same dialog redrawn: the tap lands, and the card says sent",
  withDir(async () => {
    card("om_1", WIDE);
    const world = feishuWorld(NARROW);
    const outcome = handleFeishuEvent(tap("om_1"), world.deps({ callState: () => "open", screenCall: () => CALL }));
    const result = await outcome.work();
    assert.equal(result.ok, true);
    assert.ok(world.calls.includes("pane send-keys w1Z:p1 1"));
    assert.match(world.updates.at(-1).note, /^1\. Yes\nsent · Git-Repo · pane 1$/);
    assert.equal(lookupOutbound("om_1").spent, "sent");
  }),
);

test(
  "a dialog that cannot be told apart: nothing pressed, a new card for what is up, the old one says so",
  withDir(async () => {
    card("om_1", WIDE, undefined);
    const world = feishuWorld(NARROW);
    const result = await handleFeishuEvent(tap("om_1"), world.deps()).work();
    assert.equal(result.replaced, true);
    assert.ok(!world.calls.some((line) => line.includes("send-keys")));
    assert.match(world.updates.at(-1).note, /^1\. Yes\n弹框变了，没按 · Git-Repo · pane 1\n已换成下面这张新卡片$/);
    // The new card: the dialog as it is drawn now, with its own buttons, in
    // the main session's layout.
    assert.equal(world.sent.length, 1);
    assert.match(world.sent[0].text, /^主会话在等你确认\n\n/);
    assert.deepEqual(world.sent[0].buttons, ["1", "2", "esc"]);
    assert.equal(lookupOutbound("om_new_1").fingerprint, dialogFingerprint(NARROW));
    assert.equal(lookupOutbound("om_1").spent, "stale");
    // Tapping the new card lands.
    const again = await handleFeishuEvent(tap("om_new_1"), world.deps()).work();
    assert.equal(again.ok, true);
    assert.ok(world.calls.includes("pane send-keys w1Z:p1 1"));
  }),
);

test(
  "a call answered elsewhere, another dialog up: a new card for that one",
  withDir(async () => {
    card("om_1", WIDE);
    const world = feishuWorld(OTHER);
    const result = await handleFeishuEvent(tap("om_1"), world.deps({ callState: () => "answered" })).work();
    assert.equal(result.replaced, true);
    assert.match(world.sent[0].text, /example\.net/);
  }),
);

test(
  "no dialog left: the card says it was already dealt with, and offers nothing more",
  withDir(async () => {
    card("om_1", WIDE);
    const world = feishuWorld(ANSWERED);
    const result = await handleFeishuEvent(tap("om_1"), world.deps({ callState: () => "answered" })).work();
    assert.equal(result.handled, true);
    assert.equal(world.sent.length, 0);
    assert.match(world.updates.at(-1).note, /^1\. Yes\n这个确认已经处理过了 · Git-Repo · pane 1$/);
  }),
);

test(
  "a second blocked for the same open call is not pinged while its card can be pressed",
  withDir(async () => {
    const open = { state: () => "open", openPanel: () => undefined };
    assert.equal(alreadyShown("w1Z:p1", CALL, open), undefined);
    card("om_1", WIDE);
    assert.equal(alreadyShown("w1Z:p1", CALL, open), "card");
    // A different call, a form, a call already answered: a new card is due.
    assert.equal(alreadyShown("w1Z:p1", OTHER_CALL, open), undefined);
    assert.equal(alreadyShown("w1Z:p1", { ...CALL, asks: true }, open), undefined);
    assert.equal(alreadyShown("w1Z:p1", CALL, { ...open, state: () => "answered" }), undefined);
    assert.equal(alreadyShown("w1Z:p2", CALL, open), undefined);
    // A panel open for it counts too.
    assert.equal(alreadyShown("w1Z:p1", OTHER_CALL, { ...open, openPanel: () => ({ pid: 1234, callId: OTHER_CALL.id }) }), "panel");
    // Once the card is spent (refused as stale, replaced), the next blocked
    // for the same call pings again: the user is never left without one.
    markOutbound("om_1", { spent: "stale" });
    assert.equal(alreadyShown("w1Z:p1", CALL, open), undefined);
  }),
);

// ---------------------------------------------------------------------------
// The escalation clock goes by the call too.

const MINUTE = 60_000;

test(
  "an escalation keeps its clock while the same call's dialog is redrawn",
  withDir(async () => {
    const t0 = 9_000_000;
    armEscalation({ paneId: "w75:p7", role: "supervisor", name: "orch-x", kind: "claude", where: "Git-Repo · orch", fingerprint: dialogFingerprint(WIDE), call: CALL, thresholdSec: 300 }, t0);
    // The hook seeing the redrawn dialog keeps the clock as well.
    assert.equal(
      armEscalation({ paneId: "w75:p7", role: "supervisor", name: "orch-x", kind: "claude", where: "Git-Repo · orch", fingerprint: dialogFingerprint(NARROW), call: CALL }, t0 + MINUTE).kept,
      true,
    );
    const pinged = [];
    const pass = (now, extra = {}) =>
      checkEscalations({
        now,
        run: (args) =>
          args[0] === "pane" && args[1] === "get"
            ? { status: 0, stdout: JSON.stringify({ result: { pane: { agent_status: "blocked" } } }) }
            : { status: 0, stdout: JSON.stringify({ result: { agents: [] } }) },
        readScreen: () => NARROW,
        settings: roleSettings({ MAIN_AGENT_NAME: "drover" }),
        enabled: true,
        channels: ["feishu"],
        panelReady: false,
        ping: async (call) => pinged.push(call),
        body: () => "WebFetch · https://example.org",
        wait: async () => {},
        log: () => {},
        state: () => "open",
        screenCall: () => CALL,
        ...extra,
      });
    assert.deepEqual(await pass(t0 + 3 * MINUTE), [{ paneId: "w75:p7", outcome: "waiting" }]);
    assert.equal(readEscalations()["w75:p7"].startedAt, t0);
    assert.deepEqual(await pass(t0 + 5 * MINUTE), [{ paneId: "w75:p7", outcome: "pinged" }]);
    // The card carries the dialog as drawn now, and the call.
    assert.equal(pinged[0].fingerprint, dialogFingerprint(NARROW));
    assert.equal(pinged[0].call.id, CALL.id);

    // The call answered and another one up: a new dialog, a new clock.
    assert.deepEqual(await pass(t0 + 6 * MINUTE, { readScreen: () => OTHER, state: () => "answered", screenCall: () => OTHER_CALL }), [
      { paneId: "w75:p7", outcome: "reset" },
    ]);
    assert.equal(readEscalations()["w75:p7"].call.id, OTHER_CALL.id);
    assert.equal(readEscalations()["w75:p7"].startedAt, t0 + 6 * MINUTE);
  }),
);
