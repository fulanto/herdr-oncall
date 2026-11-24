import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dialogFingerprint, roleSettings, sendTestPings } from "../src/lib/index.mjs";
import { handleFeishuEvent } from "../src/inbound/feishu.mjs";
import { readInbox } from "../src/inbound/main-inbox.mjs";
import { handleTelegramUpdate, rememberOutbound } from "../src/inbound/reply.mjs";

// A test ping (the `test` action) is about no pane. What the chat is told when
// a message is about one, word for word as the README quotes it: `quoted` to
// a reply that quotes the test ping, `latest` to a message that names no ping
// while the latest ping is a test ping.
const ENGLISH = {
  quoted: "This is a test ping, so nothing was sent to any pane. To answer an agent, reply to a real ping.",
  latest: "The latest ping is a test ping, so nothing was sent to any pane. To answer an agent, reply to a real ping.",
};
const CHINESE = {
  quoted: "这是测试通知，这条没有送进任何 pane。要回答 agent，请引用真实的通知回复",
  latest: "最近一条通知是测试通知，这条没有送进任何 pane。要回答 agent，请引用真实的通知回复",
};
const NO_TARGET = "Reply to a ping so I know which pane.";
const DAY = 24 * 60 * 60 * 1000;

// The three setups a chat message can arrive in. Without drover, and with
// drover while BARE_MESSAGE_TARGET=last, a message that names no ping goes to
// the pane of the latest ping; with BARE_MESSAGE_TARGET=main it goes to the
// main session.
const SETUPS = {
  "no drover": { settings: roleSettings({}), notice: ENGLISH },
  "drover, last": { settings: roleSettings({ MAIN_AGENT_NAME: "drover", BARE_MESSAGE_TARGET: "last" }), notice: CHINESE },
  "drover, main": { settings: roleSettings({ MAIN_AGENT_NAME: "drover", BARE_MESSAGE_TARGET: "main" }), notice: CHINESE },
};
const TO_LATEST = ["no drover", "drover, last"];

const MAIN = "w1Z:p1";
// The pane of the real blocked ping, with its dialog still up: text typed
// there is an answer to the dialog.
const ASKING = "w8:p1";
// The pane of a real done ping.
const FINISHED = "w9:p2";

const DIALOG = [
  "⏺ Bash(rm -rf -- /tmp/draft)",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "  Esc to cancel · Tab to amend",
].join("\n");
const IDLE_SCREEN = ["⏺ done.", "", "────────", "❯ ", "────────", "  ⏵⏵ auto mode on"].join("\n");

// A herdr stand-in: the main session and the finished pane are idle, the
// asking pane sits in its dialog; every argv is recorded.
function fakeHerdr() {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    const [group, verb, paneId] = args;
    if (group === "agent" && verb === "list") {
      return { status: 0, stdout: JSON.stringify({ result: { agents: [{ name: "drover", pane_id: MAIN, agent: "claude", agent_status: "idle" }] } }) };
    }
    if (group === "pane" && verb === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent_status: paneId === ASKING ? "blocked" : "idle" } }) };
    }
    if (verb === "read") {
      if (args.includes("ansi")) {
        return { status: 0, stdout: "" };
      }
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: paneId === ASKING ? DIALOG : IDLE_SCREEN } } }) };
    }
    return { status: 0, stdout: "" };
  };
  // Everything that types or presses in a pane.
  const typed = () => calls.filter((call) => /^(pane send-keys|pane send-text|agent prompt) /.test(call));
  return { run, calls, typed };
}

// The herdr these cases run "in": a fixed socket under a directory that does
// not exist, so nothing asks the CLI for it and it reads the same everywhere.
const SOCKET = "/oncall-test/test-ping/herdr.sock";

async function inState(body) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-testping-"));
  const env = { HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"), HERDR_SOCKET_PATH: SOCKET };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await body(dir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

let events = 0;

// The two chats, through their real handlers. `say` sends one message from the
// paired user, quoting `quoted` if given, and returns what herdr was asked to
// type and what the chat was told.
const CHATS = {
  telegram: {
    testPing: 501,
    blockedPing: 42,
    donePing: 43,
    prefix: "[Telegram] ",
    async deliver({ text, quoted, settings, run, said, now }) {
      const message = { message_id: 700 + ++events, chat: { id: 9 }, text };
      if (quoted !== undefined) {
        message.reply_to_message = { message_id: quoted };
      }
      await handleTelegramUpdate(
        { update_id: events, message },
        {
          token: "t",
          chatId: "9",
          run,
          wait: async () => {},
          settings,
          enabled: true,
          now,
          send: async (_token, _chat, body) => {
            said.push(body);
            return 900 + said.length;
          },
        },
      );
    },
  },
  feishu: {
    testPing: "om_test",
    blockedPing: "om_7",
    donePing: "om_8",
    prefix: "[飞书] ",
    async deliver({ text, quoted, settings, run, said, now }) {
      events++;
      const outcome = handleFeishuEvent(
        {
          header: { event_id: `ev-${events}`, event_type: "im.message.receive_v1", app_id: "cli_1" },
          event: {
            sender: { sender_id: { open_id: "ou_me" } },
            message: {
              message_id: `om_user_${events}`,
              parent_id: quoted,
              chat_type: "p2p",
              message_type: "text",
              content: JSON.stringify({ text }),
            },
          },
        },
        {
          creds: { appId: "cli_1", appSecret: "s", brand: "feishu" },
          openId: "ou_me",
          seen: new Map(),
          run,
          wait: async () => {},
          settings,
          enabled: true,
          now,
          send: async (_creds, _openId, body) => {
            said.push(body);
            return `om_${said.length + 100}`;
          },
        },
      );
      if (outcome.work) {
        await outcome.work();
      }
    },
  },
};

async function say(chat, setup, text, { quoted, now } = {}) {
  const herdr = fakeHerdr();
  const said = [];
  await CHATS[chat].deliver({ text, quoted, settings: SETUPS[setup].settings, run: herdr.run, said, now });
  return { typed: herdr.typed(), said };
}

// The `test` action's ping on this chat, sent `at`.
function testPing(chat, at) {
  return sendTestPings([chat], "test ping", { send: async () => CHATS[chat].testPing, log: () => {}, error: () => {}, now: at });
}

function blockedPing(chat, at) {
  rememberOutbound(
    {
      messageId: CHATS[chat].blockedPing,
      paneId: ASKING,
      status: "blocked",
      where: "api-service · main",
      title: "blocked · Claude",
      fingerprint: dialogFingerprint(DIALOG),
      options: [
        { key: "1", send: "1", label: "Yes" },
        { key: "2", send: "2", label: "No" },
      ],
      channel: chat,
      text: "blocked · Claude\napi-service · main\n\nDo you want to proceed?",
    },
    at,
  );
}

function donePing(chat, at) {
  rememberOutbound({ messageId: CHATS[chat].donePing, paneId: FINISHED, status: "done", where: "billing-worker · e2e", channel: chat }, at);
}

for (const chat of Object.keys(CHATS)) {
  for (const setup of Object.keys(SETUPS)) {
    test(`a reply that quotes the test ping is told so and reaches no pane · ${chat} · ${setup}`, () =>
      inState(async () => {
        const now = Date.now();
        // A real ping came after the test ping and its dialog is still up:
        // only the quote says this message is about the test ping.
        await testPing(chat, now - 60_000);
        blockedPing(chat, now - 30_000);
        const { typed, said } = await say(chat, setup, "收到", { quoted: CHATS[chat].testPing });
        assert.deepEqual(typed, [], "nothing is typed or pressed in any pane");
        assert.deepEqual(said, [SETUPS[setup].notice.quoted]);
        assert.deepEqual(readInbox(), [], "and nothing waits for the main session");
      }));
  }

  for (const setup of TO_LATEST) {
    test(`a plain message while the test ping is the latest ping reaches no pane, until a real ping comes · ${chat} · ${setup}`, () =>
      inState(async () => {
        const now = Date.now();
        blockedPing(chat, now - 60_000);
        await testPing(chat, now - 30_000);
        const first = await say(chat, setup, "收到");
        assert.deepEqual(first.typed, [], "nothing is typed or pressed in any pane");
        // Told what is in the way: this message quoted nothing.
        assert.deepEqual(first.said, [SETUPS[setup].notice.latest]);

        donePing(chat, now - 10_000);
        const second = await say(chat, setup, "继续");
        assert.deepEqual(second.typed, [`agent prompt ${FINISHED} 继续`]);
        assert.deepEqual(second.said, ["sent · billing-worker · e2e"]);
      }));

    test(`a test ping older than the latest real ping changes nothing for a plain message · ${chat} · ${setup}`, async () => {
      const outcome = (withTestPing) =>
        inState(async () => {
          const now = Date.now();
          if (withTestPing) {
            await testPing(chat, now - 60_000);
          }
          donePing(chat, now - 30_000);
          return say(chat, setup, "继续");
        });
      const without = await outcome(false);
      assert.deepEqual(without.typed, [`agent prompt ${FINISHED} 继续`]);
      assert.deepEqual(await outcome(true), without);
    });

    test(`a test ping is on record for 24 hours · ${chat} · ${setup}`, async () => {
      const quoting = (age) =>
        inState(async () => {
          const now = Date.now();
          await testPing(chat, now - age);
          donePing(chat, now - 120_000);
          return say(chat, setup, "收到", { quoted: CHATS[chat].testPing });
        });
      const live = await quoting(DAY - 60_000);
      assert.deepEqual(live.typed, []);
      assert.deepEqual(live.said, [SETUPS[setup].notice.quoted]);
      // Past that it is a message Oncall no longer knows, and a reply that
      // quotes one goes where a plain message goes.
      const expired = await quoting(DAY + 1000);
      assert.deepEqual(expired.typed, [`agent prompt ${FINISHED} 收到`]);
      assert.deepEqual(expired.said, ["sent · billing-worker · e2e"]);
    });

    test(`with no real ping on record, a plain message after a test ping is told so; an expired one is no ping at all · ${chat} · ${setup}`, async () => {
      const plain = (age) =>
        inState(async () => {
          await testPing(chat, Date.now() - age);
          return say(chat, setup, "收到");
        });
      assert.deepEqual(await plain(60_000), { typed: [], said: [SETUPS[setup].notice.latest] });
      assert.deepEqual(await plain(DAY + 1000), { typed: [], said: [NO_TARGET] });
    });
  }

  test(`with BARE_MESSAGE_TARGET=main a plain message goes to the main session, test ping or not · ${chat}`, async () => {
    const outcome = (withTestPing) =>
      inState(async () => {
        const now = Date.now();
        blockedPing(chat, now - 60_000);
        if (withTestPing) {
          await testPing(chat, now - 30_000);
        }
        return say(chat, "drover, main", "进度怎么样");
      });
    const without = await outcome(false);
    assert.deepEqual(without.typed, [`agent prompt ${MAIN} ${CHATS[chat].prefix}进度怎么样`]);
    assert.deepEqual(without.said, ["已送达主会话"]);
    assert.deepEqual(await outcome(true), without);
  });
}

test("the 24 hours are exact: one millisecond short the test ping is still known, at 24 hours it is not", () =>
  inState(async () => {
    await testPing("feishu", 1000);
    donePing("feishu", 2000);
    const quoted = { quoted: CHATS.feishu.testPing };
    const before = await say("feishu", "drover, last", "收到", { ...quoted, now: 1000 + DAY - 1 });
    assert.deepEqual(before, { typed: [], said: [CHINESE.quoted] });
    const after = await say("feishu", "drover, last", "收到", { ...quoted, now: 1000 + DAY });
    assert.deepEqual(after.typed, [`agent prompt ${FINISHED} 收到`]);
  }));

test("sendTestPings pings every channel on its own, says which went out, and counts the ones that failed", () =>
  inState(async () => {
    const sent = [];
    const logged = [];
    const errors = [];
    const failed = await sendTestPings(["feishu", "telegram"], "test ping\n\nblocked · Claude", {
      send: async (channel, text, options) => {
        sent.push([channel, text, options]);
        if (channel === "feishu") {
          throw new Error("feishu is down");
        }
        return CHATS.telegram.testPing;
      },
      log: (line) => logged.push(line),
      error: (line) => errors.push(line),
    });
    assert.equal(failed, 1);
    assert.deepEqual(sent, [
      ["feishu", "test ping\n\nblocked · Claude", { status: "test" }],
      ["telegram", "test ping\n\nblocked · Claude", { status: "test" }],
    ]);
    assert.deepEqual(logged, ["sent test ping · telegram"]);
    assert.deepEqual(errors, ["feishu test ping failed: feishu is down"]);
    // The one that went out is on record.
    const { typed, said } = await say("telegram", "no drover", "收到", { quoted: CHATS.telegram.testPing });
    assert.deepEqual({ typed, said }, { typed: [], said: [ENGLISH.quoted] });
  }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_TELEGRAM = join(ROOT, "test", "helpers", "fake-telegram.mjs");

// The action itself, run as Herdr runs it but with a made-up bot: the network
// is replaced before any of its code loads (test/helpers/fake-telegram.mjs),
// every channel setting is given here so no .env decides it, and its state and
// config are this case's temp dirs.
test("the test action's own ping is on record: a reply that quotes it reaches no pane", () =>
  inState(async (dir) => {
    blockedPing("telegram", Date.now() - 60_000);
    const action = spawnSync(process.execPath, ["src/actions/test.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import "${FAKE_TELEGRAM}"`,
        HERDR_BIN_PATH: join(dir, "no-herdr"),
        CHANNEL: "telegram",
        TELEGRAM_BOT_TOKEN: "made-up-token",
        TELEGRAM_CHAT_ID: "9",
        FEISHU_APP_ID: "",
        FEISHU_APP_SECRET: "",
        FEISHU_OPEN_ID: "",
        FEISHU_DOMAIN: "",
      },
    });
    assert.equal(action.status, 0, `${action.stdout}\n${action.stderr}`);
    assert.match(action.stdout, /^sent test ping · telegram$/m);

    // 501 is the message id fake-telegram.mjs answers sendMessage with.
    const { typed, said } = await say("telegram", "no drover", "收到", { quoted: 501 });
    assert.deepEqual(typed, [], "nothing is typed or pressed in any pane");
    assert.deepEqual(said, [ENGLISH.quoted]);
  }));
