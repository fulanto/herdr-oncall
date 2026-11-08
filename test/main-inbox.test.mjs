import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dialogFingerprint, roleSettings } from "../src/lib/index.mjs";
import {
  ABSENT_GRACE_MS,
  LATE_NOTICE_MS,
  OFF_NOTICE,
  clearMainTurn,
  currentMainTurn,
  drainInbox,
  helpText,
  inputDraft,
  readInbox,
  routeToMain,
  sanitizeForAgent,
} from "../src/inbound/main-inbox.mjs";
import { handleFeishuEvent } from "../src/inbound/feishu.mjs";
import { handleTelegramUpdate, rememberOutbound } from "../src/inbound/reply.mjs";

const DROVER = roleSettings({ MAIN_AGENT_NAME: "drover", BARE_MESSAGE_TARGET: "main" });
const MAIN = "w1Z:p1";

// Screens captured from a live Claude Code 2.1.319 and Codex 0.166.0 with
// `herdr pane read <pane> --source visible --format ansi` (bottom lines).
const RULE = "\x1b[0m\x1b[38;5;7m──────────────────────────────────────────────────────────────────────\x1b[0m";
const CLAUDE_FOOTER = [
  "  \x1b[0m\x1b[1m\x1b[38;5;2m➜\x1b[0m\x1b[2m\x1b[38;5;7m \x1b[0m\x1b[38;5;6mtask-oncall-into-drover-plugin\x1b[0m\x1b[2m\x1b[38;5;7m \x1b[0m\x1b[1m\x1b[38;5;4mgit:(\x1b[0m\x1b[38;5;1mtask/oncall-into-drover-plu…\x1b[0m",
  "  \x1b[0m\x1b[38;5;11m⏵⏵ auto mode on\x1b[0m\x1b[2m\x1b[38;5;7m (shift+tab to cycle) · ← 1 agent\x1b[0m",
];
function claudeBox(...boxLines) {
  return ["  \x1b[0m\x1b[38;5;11m⚠ claude.ai connectors are disabled\x1b[0m", RULE, ...boxLines, RULE, ...CLAUDE_FOOTER].join("\n");
}
const CLAUDE_EMPTY = claudeBox('❯ \x1b[0m\x1b[2mTry "how do I log an error?"\x1b[0m');
const CLAUDE_CLEARED = claudeBox("❯ ");
const CLAUDE_DRAFT = claudeBox("❯ 草稿：这句话还没写完");
const CLAUDE_MULTILINE = claudeBox("❯ 多行草稿第一行", "  多行草稿第二行");
const CODEX_BG = "\x1b[48;2;48;50;66m";
const CODEX_FOOTER =
  "  \x1b[0m\x1b[38;2;246;226;183mGPT-6-Astra low Fast\x1b[0m\x1b[38;2;69;142;110m · \x1b[0m\x1b[38;2;171;223;167m~/.herdr/worktree…\x1b[0m";
const CODEX_EMPTY = [
  `\x1b[0m${CODEX_BG}                                  \x1b[0m\x1b[38;2;42;100;80m${CODEX_BG}⢀\x1b[0m${CODEX_BG}     \x1b[0m`,
  `\x1b[0m\x1b[1m${CODEX_BG}›\x1b[0m${CODEX_BG} \x1b[0m\x1b[2m${CODEX_BG}Ask Codex to do anything\x1b[0m\x1b[38;2;40;114;84m${CODEX_BG}⡀\x1b[0m${CODEX_BG}        \x1b[0m\x1b[38;2;46;60;69m${CODEX_BG}⠈\x1b[0m`,
  `\x1b[0m${CODEX_BG}      \x1b[0m\x1b[38;2;47;58;68m${CODEX_BG}⠠\x1b[0m`,
  CODEX_FOOTER,
].join("\n");
const CODEX_DRAFT = [
  `\x1b[0m${CODEX_BG}                                                                      \x1b[0m`,
  `\x1b[0m\x1b[1m${CODEX_BG}›\x1b[0m${CODEX_BG} 单行草稿                                                            \x1b[0m`,
  `\x1b[0m${CODEX_BG}                                                                      \x1b[0m`,
  CODEX_FOOTER,
].join("\n");

const IDLE_SCREEN = ["⏺ 进度：三个编排者都在跑。", "", "────────", "❯ ", "────────", "  ⏵⏵ auto mode on"].join("\n");
const DIALOG = [
  "⏺ Bash(git push origin main)",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "  Esc to cancel · Tab to amend",
].join("\n");

test("the placeholder of an empty box is not a draft, typed text is", () => {
  assert.equal(inputDraft(CLAUDE_EMPTY), "");
  assert.equal(inputDraft(CLAUDE_CLEARED), "");
  assert.equal(inputDraft(CLAUDE_DRAFT), "草稿：这句话还没写完");
  assert.equal(inputDraft(CLAUDE_MULTILINE), "多行草稿第一行\n多行草稿第二行");
  // Codex's dots are coloured, not dim, and still are not text.
  assert.equal(inputDraft(CODEX_EMPTY), "");
  assert.equal(inputDraft(CODEX_DRAFT), "单行草稿");
  assert.equal(inputDraft(""), "");
  // A green `38;5;2` is a colour, not SGR 2 (dim).
  assert.equal(inputDraft(claudeBox("❯ \x1b[38;5;2mgreen text\x1b[0m")), "green text");
});

test("what goes in is cleaned: no control characters, newlines kept, at most 2000 characters", () => {
  assert.deepEqual(sanitizeForAgent("abc\x1bdef"), { text: "abcdef", chars: 6, truncated: false });
  assert.equal(sanitizeForAgent("abc\x1b[201~def").text, "abc[201~def");
  assert.equal(sanitizeForAgent("a\x03b\x7fc\u009bd").text, "abcd");
  assert.equal(sanitizeForAgent("第一行\r\n第二行\r第三行").text, "第一行\n第二行\n第三行");
  assert.equal(sanitizeForAgent("a\tb").text, "a b");
  const long = sanitizeForAgent("长".repeat(2500));
  assert.equal(long.truncated, true);
  assert.equal(long.chars, 2500);
  assert.equal(Array.from(long.text).length, 2000);
});

// ---------------------------------------------------------------------------

function withState(body) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-main-"));
    const previous = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
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

// A herdr stand-in for the main session. `main` is what `agent list` says
// about it (undefined: no agent has the name), `screen` and `ansi` what its
// pane shows. Clearing keys empty the box; every argv is recorded.
function mainHerdr(state) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const [group, verb] = args;
    if (group === "agent" && verb === "list") {
      const agents = state.main ? [{ name: "drover", pane_id: MAIN, ...state.main }] : [];
      return { status: 0, stdout: JSON.stringify({ result: { agents } }) };
    }
    if (group === "pane" && verb === "read") {
      if (args.includes("ansi")) {
        return { status: 0, stdout: state.ansi ?? CLAUDE_EMPTY };
      }
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: state.screen ?? IDLE_SCREEN } } }) };
    }
    if (group === "pane" && verb === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent: { state: state.main?.agent_status } } }) };
    }
    if (group === "pane" && verb === "send-keys") {
      if (args.includes("ctrl+u")) {
        state.draftLines = (state.draftLines ?? 1) - 1;
        if (state.draftLines <= 0) {
          state.ansi = CLAUDE_CLEARED;
        }
      }
      return { status: 0, stdout: "" };
    }
    if (group === "agent" && verb === "prompt") {
      if (state.main?.agent_status === "blocked") {
        return { status: 1, stdout: "", stderr: '{"error":{"code":"agent_blocked"}}' };
      }
      return { status: 0, stdout: "{}" };
    }
    return { status: 0, stdout: "" };
  };
  const prompts = () => calls.filter((args) => args[0] === "agent" && args[1] === "prompt").map((args) => args.slice(2));
  return { run, calls, prompts };
}

function recorder(name = "feishu") {
  const said = [];
  return { said, channel: { name, reply: async (text) => said.push(text), ping: async () => "om_ping" } };
}

test(
  "an idle main session takes the message at once, prefixed, and the turn is remembered",
  withState(async () => {
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "idle" } });
    const chat = recorder();
    const outcome = await routeToMain("进度怎么样", { channel: chat.channel, messageId: "om_user_1", settings: DROVER, run: herdr.run, now: 1000, log: () => {} });
    assert.equal(outcome.delivered, true);
    assert.deepEqual(herdr.prompts(), [[MAIN, "[飞书] 进度怎么样"]]);
    assert.deepEqual(chat.said, ["已送达主会话"]);
    assert.deepEqual(currentMainTurn(MAIN, 2000), { paneId: MAIN, channel: "feishu", messageId: "om_user_1", deliveredAt: 1000 });
    // Not some other pane's turn, and gone once answered.
    assert.equal(currentMainTurn("w75:p4", 2000), undefined);
    clearMainTurn(MAIN);
    assert.equal(currentMainTurn(MAIN, 2000), undefined);
  }),
);

test(
  "a long message is cut at 2000 characters and the ack says so; Telegram has its own prefix",
  withState(async () => {
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "done" } });
    const chat = recorder("telegram");
    await routeToMain(`!${"字".repeat(2100)}`, { channel: chat.channel, messageId: 42, settings: DROVER, run: herdr.run, log: () => {} });
    const [[, text]] = herdr.prompts();
    assert.ok(text.startsWith("[Telegram] !字"));
    assert.equal(Array.from(text.slice("[Telegram] ".length)).length, 2000);
    assert.deepEqual(chat.said, ["已送达主会话（超过 2000 字，只送了前 2000 字）"]);
  }),
);

test(
  "Claude Code at work queues the message itself; Codex at work would drop its turn, so it waits",
  withState(async () => {
    const claude = mainHerdr({ main: { agent: "claude", agent_status: "working" } });
    const chat = recorder();
    await routeToMain("顺便看下 CI", { channel: chat.channel, settings: DROVER, run: claude.run, log: () => {} });
    assert.deepEqual(claude.prompts(), [[MAIN, "[飞书] 顺便看下 CI"]]);
    assert.deepEqual(chat.said, ["已送达，主会话正在处理上一件事，会接着看"]);

    const state = { main: { agent: "codex", agent_status: "working" }, ansi: CODEX_EMPTY };
    const codex = mainHerdr(state);
    const codexChat = recorder();
    const stashed = await routeToMain("顺便看下 CI", { channel: codexChat.channel, settings: DROVER, run: codex.run, now: 1000, log: () => {} });
    assert.equal(stashed.reason, "codex-busy");
    assert.deepEqual(codex.prompts(), []);
    assert.match(codexChat.said[0], /Codex 收到新消息会打断当前这一轮/);

    state.main.agent_status = "done";
    const drained = await drainInbox({ channelFor: () => codexChat.channel, settings: DROVER, run: codex.run, now: 61_000, enabled: true, log: () => {} });
    assert.ok(drained.delivered);
    assert.deepEqual(codex.prompts(), [[MAIN, "[飞书] 顺便看下 CI"]]);
    assert.equal(codexChat.said[1], "已送达主会话（暂存了 1 分钟）");
    assert.deepEqual(readInbox(), []);
  }),
);

test(
  "a waiting dialog holds the message until it is answered, and nothing is typed into it",
  withState(async () => {
    const state = { main: { agent: "claude", agent_status: "blocked" }, screen: DIALOG };
    const herdr = mainHerdr(state);
    const chat = recorder();
    await routeToMain("先别推", { channel: chat.channel, settings: DROVER, run: herdr.run, now: 1000, log: () => {} });
    assert.deepEqual(chat.said, ["主会话在等确认：Do you want to proceed?。先回那条确认通知；你这条已暂存，确认完自动送"]);
    assert.deepEqual(herdr.prompts(), []);

    assert.deepEqual(await drainInbox({ channelFor: () => chat.channel, settings: DROVER, run: herdr.run, now: 6000, enabled: true, log: () => {} }), {
      waiting: "blocked",
    });
    assert.deepEqual(herdr.prompts(), []);

    // Herdr's status can lag the screen: a menu still drawn is still a dialog.
    state.main.agent_status = "idle";
    assert.deepEqual((await drainInbox({ channelFor: () => chat.channel, settings: DROVER, run: herdr.run, now: 9000, enabled: true, log: () => {} })).waiting, "blocked");

    state.screen = IDLE_SCREEN;
    const drained = await drainInbox({ channelFor: () => chat.channel, settings: DROVER, run: herdr.run, now: 12_000, enabled: true, log: () => {} });
    assert.ok(drained.delivered);
    assert.deepEqual(herdr.prompts(), [[MAIN, "[飞书] 先别推"]]);
  }),
);

test(
  "a draft in the box holds the message; /send clears it and lets the message go",
  withState(async () => {
    const state = { main: { agent: "claude", agent_status: "idle" }, ansi: CLAUDE_MULTILINE, draftLines: 2 };
    const herdr = mainHerdr(state);
    const chat = recorder();
    await routeToMain("帮我看下日志", { channel: chat.channel, settings: DROVER, run: herdr.run, now: 1000, log: () => {} });
    assert.match(chat.said[0], /^终端输入框里有没发出的内容「多行草稿第一行 多行草稿第二行」，你这条已暂存。回 \/send 清空草稿后送入/);
    assert.deepEqual(herdr.prompts(), []);

    const outcome = await handleFeishuEvent(feishuText("/send"), feishuDeps(herdr.run, chat, { now: 61_000 }));
    const result = await outcome.work();
    assert.equal(result.command, "send");
    const keys = herdr.calls.filter((args) => args[1] === "send-keys").map((args) => args.slice(2).join(" "));
    assert.deepEqual(keys, [`${MAIN} ctrl+u backspace`, `${MAIN} ctrl+u backspace`]);
    assert.deepEqual(herdr.prompts(), [[MAIN, "[飞书] 帮我看下日志"]]);
    assert.equal(chat.said[1], "已清空终端草稿「多行草稿第一行 多行草稿第二行」，暂存的 1 条按顺序送入");
    assert.equal(chat.said[2], "已送达主会话（暂存了 1 分钟）");
  }),
);

test(
  "/send never presses keys into a dialog",
  withState(async () => {
    // The dialog's cursor line reads like a box with text in it.
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "blocked" }, screen: DIALOG, ansi: claudeBox("  ❯ 1. Yes") });
    const chat = recorder();
    const result = await feishu(feishuText("/send"), feishuDeps(herdr.run, chat));
    assert.equal(result.skipped, "blocked");
    assert.ok(!herdr.calls.some((args) => args[1] === "send-keys"));
    assert.equal(chat.said.at(-1), "主会话在等确认：Do you want to proceed?。先回那条确认通知，没有清草稿");
  }),
);

test(
  "a message that arrives while the main session has no name yet waits for it",
  withState(async () => {
    const state = { main: undefined };
    const herdr = mainHerdr(state);
    const chat = recorder();
    const outcome = await routeToMain("进度？", { channel: chat.channel, messageId: "om_2", settings: DROVER, run: herdr.run, now: 1000, log: () => {} });
    assert.equal(outcome.reason, "absent");
    // Nothing said yet: drover is most likely registering it again right now.
    assert.deepEqual(chat.said, []);

    state.main = { agent: "claude", agent_status: "idle" };
    const drained = await drainInbox({ channelFor: () => chat.channel, settings: DROVER, run: herdr.run, now: 6000, enabled: true, log: () => {} });
    assert.ok(drained.delivered);
    assert.deepEqual(herdr.prompts(), [[MAIN, "[飞书] 进度？"]]);
    assert.deepEqual(chat.said, ["已送达主会话"]);
    assert.equal(currentMainTurn(MAIN, 7000).messageId, "om_2");
  }),
);

test(
  "a main session that never shows up is reported after the grace, and the message dropped",
  withState(async () => {
    const herdr = mainHerdr({ main: undefined });
    const chat = recorder();
    await routeToMain("进度？", { channel: chat.channel, settings: DROVER, run: herdr.run, now: 1000, log: () => {} });
    const drain = (now) => drainInbox({ channelFor: () => chat.channel, settings: DROVER, run: herdr.run, now, enabled: true, log: () => {} });
    assert.deepEqual(await drain(1000 + ABSENT_GRACE_MS - 5000), { waiting: "absent" });
    assert.deepEqual(chat.said, []);
    assert.ok((await drain(1000 + ABSENT_GRACE_MS)).refused);
    assert.deepEqual(chat.said, ["没找到主会话（herdr 里名为 drover 的 agent），在主会话里跑 drover main-register"]);
    assert.deepEqual(readInbox(), []);
  }),
);

test(
  "a message still waiting after half an hour is mentioned once, and kept",
  withState(async () => {
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "blocked" }, screen: DIALOG });
    const chat = recorder();
    await routeToMain("先别推", { channel: chat.channel, settings: DROVER, run: herdr.run, now: 0, log: () => {} });
    await routeToMain("还有这个", { channel: chat.channel, settings: DROVER, run: herdr.run, now: 1000, log: () => {} });
    assert.equal(chat.said[1], "你这条已暂存，排在前面 1 条后面，主会话能接收时按顺序送");
    const drain = (now) => drainInbox({ channelFor: () => chat.channel, settings: DROVER, run: herdr.run, now, enabled: true, log: () => {} });
    await drain(LATE_NOTICE_MS + 1000);
    assert.deepEqual(chat.said.slice(2), [
      "还没送进去：「[飞书] 先别推」（主会话在等确认：Do you want to proceed?），仍在暂存",
      "还没送进去：「[飞书] 还有这个」（主会话在等确认：Do you want to proceed?），仍在暂存",
    ]);
    await drain(LATE_NOTICE_MS + 6000);
    assert.equal(chat.said.length, 4);
    assert.equal(readInbox().length, 2);
  }),
);

// ---------------------------------------------------------------------------
// The chat side: what a Feishu (or Telegram) message does once MAIN_AGENT_NAME
// is set, through the real handlers.

let eventCount = 0;
function feishuText(text, { parent } = {}) {
  eventCount++;
  return {
    header: { event_id: `ev-main-${eventCount}`, event_type: "im.message.receive_v1", app_id: "cli_1" },
    event: {
      sender: { sender_id: { open_id: "ou_me" } },
      message: {
        message_id: `om_user_${eventCount}`,
        parent_id: parent,
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
  };
}

function feishuTap(messageId, send) {
  eventCount++;
  return {
    header: { event_id: `ev-tap-${eventCount}`, event_type: "card.action.trigger", app_id: "cli_1" },
    event: { operator: { open_id: "ou_me" }, action: { value: { send } }, context: { open_message_id: messageId } },
  };
}

function feishuDeps(run, chat, extra = {}) {
  return {
    creds: { appId: "cli_1", appSecret: "s", brand: "feishu" },
    openId: "ou_me",
    seen: new Map(),
    run,
    wait: async () => {},
    settings: DROVER,
    enabled: true,
    channelFor: () => chat.channel,
    send: async (_creds, _openId, text) => {
      chat.said.push(text);
      return `om_${chat.said.length + 100}`;
    },
    ...extra,
  };
}

async function feishu(envelope, deps) {
  const outcome = handleFeishuEvent(envelope, deps);
  return outcome.work ? outcome.work() : outcome;
}

test(
  "/off is the existing switch, and while off nothing from the chat reaches a pane",
  withState(async () => {
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "idle" } });
    const chat = recorder();
    const switched = [];
    const setEnabled = (value) => switched.push(value);
    assert.equal((await feishu(feishuText("/off"), feishuDeps(herdr.run, chat, { setEnabled }))).command, "off");
    assert.deepEqual(switched, [false]);
    assert.equal(chat.said.at(-1), "oncall 已关闭：不再推送，聊天里发来的消息也不再送进 agent。发 /on 打开");

    const off = feishuDeps(herdr.run, chat, { enabled: false, setEnabled });
    assert.deepEqual(await feishu(feishuText("进度怎么样"), off), { skipped: "off" });
    rememberOutbound({ messageId: "om_dialog", paneId: MAIN, status: "blocked", fingerprint: dialogFingerprint(DIALOG) });
    assert.deepEqual(await feishu(feishuText("1", { parent: "om_dialog" }), off), { skipped: "off" });
    assert.deepEqual(chat.said.slice(-2), [OFF_NOTICE, OFF_NOTICE]);
    const tap = handleFeishuEvent(feishuTap("om_dialog", "1"), off);
    assert.equal(tap.work, undefined);
    assert.deepEqual(tap.response, { toast: { type: "error", content: OFF_NOTICE } });
    assert.deepEqual(herdr.prompts(), []);
    assert.ok(!herdr.calls.some((args) => args[1] === "send-keys"));

    // /on still works while off.
    assert.equal((await feishu(feishuText("/on"), off)).command, "on");
    assert.deepEqual(switched, [false, true]);
    assert.equal(chat.said.at(-1), "oncall 已打开");
  }),
);

test(
  "/help says where a message goes, and an unknown command says it is unknown",
  withState(async () => {
    const chat = recorder();
    const deps = feishuDeps(mainHerdr({}).run, chat);
    await feishu(feishuText("/help"), deps);
    assert.equal(chat.said.at(-1), helpText(DROVER));
    assert.match(chat.said.at(-1), /^不引用直接发：送到主会话（herdr 里名为 drover 的 agent）。\n引用某条通知回复，或点卡片上的按钮：送到那条通知的 agent。/);
    await feishu(feishuText("/clear"), deps);
    assert.equal(chat.said.at(-1), "不认识的命令 /clear，发 /help 看说明");
  }),
);

test(
  "quoting the main session's done ping talks to it, prefixed; quoting its dialog answers the dialog",
  withState(async () => {
    const state = { main: { agent: "claude", agent_status: "idle" } };
    const herdr = mainHerdr(state);
    const chat = recorder();
    rememberOutbound({ messageId: "om_done", paneId: MAIN, status: "done", where: "Git-Repo · pane 1" });
    await feishu(feishuText("继续", { parent: "om_done" }), feishuDeps(herdr.run, chat));
    assert.deepEqual(herdr.prompts(), [[MAIN, "[飞书] 继续"]]);

    state.main.agent_status = "blocked";
    state.screen = DIALOG;
    rememberOutbound({
      messageId: "om_dialog",
      paneId: MAIN,
      status: "blocked",
      where: "Git-Repo · pane 1",
      fingerprint: dialogFingerprint(DIALOG),
      options: [{ key: "1", send: "1", label: "Yes" }],
    });
    await feishu(feishuText("1", { parent: "om_dialog" }), feishuDeps(herdr.run, chat));
    const keys = herdr.calls.filter((args) => args[1] === "send-keys").map((args) => args.slice(2));
    assert.deepEqual(keys, [[MAIN, "1"]]);
    assert.equal(herdr.prompts().length, 1, "the answer is a key, not a prefixed prompt");
  }),
);

test(
  "a worker's ping quoted, and BARE_MESSAGE_TARGET=last, behave as before",
  withState(async () => {
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "idle" } });
    const chat = recorder();
    rememberOutbound({ messageId: "om_worker", paneId: "w7M:p1", status: "done", where: "his-claw-agent · e2e" });
    await feishu(feishuText("再跑一遍", { parent: "om_worker" }), feishuDeps(herdr.run, chat));
    assert.deepEqual(herdr.prompts(), [["w7M:p1", "再跑一遍"]]);

    const last = roleSettings({ MAIN_AGENT_NAME: "drover", BARE_MESSAGE_TARGET: "last" });
    await feishu(feishuText("还有这个"), feishuDeps(herdr.run, chat, { settings: last }));
    assert.deepEqual(herdr.prompts().at(-1), ["w7M:p1", "还有这个"]);
  }),
);

test(
  "without MAIN_AGENT_NAME the chat is 0.6.6: no commands, a bare message to the latest ping",
  withState(async () => {
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "idle" } });
    const chat = recorder();
    const none = roleSettings({ BARE_MESSAGE_TARGET: "main" });
    const switched = [];
    const deps = feishuDeps(herdr.run, chat, { settings: none, setEnabled: (value) => switched.push(value) });
    assert.deepEqual(handleFeishuEvent(feishuText("/off"), deps), { skipped: "command" });
    assert.deepEqual(switched, []);
    rememberOutbound({ messageId: "om_any", paneId: "w8:p1", status: "done", where: "asr-service · main" });
    await feishu(feishuText("!ls"), deps);
    // Exactly what 0.6.6 typed: no prefix, no main session.
    assert.deepEqual(herdr.prompts(), [["w8:p1", "!ls"]]);
    assert.ok(!herdr.calls.some((args) => args[0] === "agent" && args[1] === "list"));
  }),
);

test(
  "a bare Telegram message reaches the main session the same way, with its own prefix",
  withState(async () => {
    const herdr = mainHerdr({ main: { agent: "claude", agent_status: "done" } });
    const said = [];
    const outcome = await handleTelegramUpdate(
      { update_id: 1, message: { message_id: 55, chat: { id: 9 }, text: "/clear 进度" } },
      { token: "t", chatId: "9", run: herdr.run, settings: DROVER, enabled: true, send: async (_t, _c, text) => said.push(text) },
    );
    assert.equal(outcome.command, "/clear");
    await handleTelegramUpdate(
      { update_id: 2, message: { message_id: 56, chat: { id: 9 }, text: "进度怎么样" } },
      { token: "t", chatId: "9", run: herdr.run, settings: DROVER, enabled: true, send: async (_t, _c, text) => said.push(text) },
    );
    assert.deepEqual(herdr.prompts(), [[MAIN, "[Telegram] 进度怎么样"]]);
    assert.equal(said.at(-1), "已送达主会话");
    assert.equal(currentMainTurn(MAIN).channel, "telegram");
    assert.equal(currentMainTurn(MAIN).messageId, "56");
  }),
);
