import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeChatAnswer, claudeLastAnswer, codexChatAnswer, roleSettings } from "../src/lib/index.mjs";
import { mainDonePings, pendingAnswers, rememberPendingAnswer, sendMainPings } from "../src/inbound/main-inbox.mjs";
import { lookupOutbound } from "../src/inbound/reply.mjs";

// Session records shaped like Claude Code 2.1.319's own (from a real main
// session watching four orchestrators with Monitor, and from a probe that had
// a message queued while it worked): a chat message is a user record holding
// the text as sent; a Monitor event is a user record starting
// "<task-notification>"; between them sit records that are not conversation
// at all (queue-operation, api-request, system turn_duration).

const T0 = Date.parse("2026-11-08T08:52:00Z");
let clock = T0;
const at = () => new Date((clock += 1000)).toISOString();

const user = (content) => ({ type: "user", isSidechain: false, timestamp: at(), message: { role: "user", content } });
const said = (text, stop = "end_turn") => ({
  type: "assistant",
  isSidechain: false,
  timestamp: at(),
  message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] },
});
const thinking = () => ({ type: "assistant", timestamp: at(), message: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…" }] } });
const toolCall = (narration) => ({
  type: "assistant",
  timestamp: at(),
  message: {
    stop_reason: "tool_use",
    content: [...(narration ? [{ type: "text", text: narration }] : []), { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
  },
});
const toolResult = (...extra) => user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }, ...extra]);
const notification = (what) => user(`<task-notification>\n<summary>${what}</summary>\n</task-notification>`);
const noise = () => [
  { type: "queue-operation", operation: "enqueue", timestamp: at() },
  { type: "queue-operation", operation: "dequeue", timestamp: at() },
  { type: "system", subtype: "turn_duration", timestamp: at() },
];

const ASKED = "[飞书] 进度怎么样";
const ANSWER = "飞书消息收到了，联调第 1 步通过。\n\n4 个任务都在跑，没有要你决定的。";
const MONITOR_TURN = "`orch-oncall` is waiting in the background; nothing changed.";

// The failure seen live: the chat turn's answer, then a Monitor event started
// the next turn straight away, and no done came between them.
function chatThenMonitor() {
  return [
    said("上一轮的回答"),
    user(ASKED),
    ...noise(),
    thinking(),
    said(ANSWER),
    ...noise(),
    notification("orch-oncall waiting-background"),
    said(MONITOR_TURN),
  ];
}

test("the chat turn's answer, not the Monitor turn that ended after it", () => {
  const records = chatThenMonitor();
  // What "the next done's answer" sent before: the Monitor turn.
  assert.equal(claudeLastAnswer(records), MONITOR_TURN);
  assert.deepEqual(claudeChatAnswer(records, { text: ASKED }), { state: "answered", answer: ANSWER });
});

test("a chat message queued into the middle of a turn is answered at that turn's end", () => {
  const separate = [
    user("把 X 做完"),
    toolCall("先看一下"),
    toolResult(),
    user("[飞书] 顺便看下 CI"),
    toolCall(),
    toolResult(),
    said("CI 是绿的；X 也做完了。"),
  ];
  assert.deepEqual(claudeChatAnswer(separate, { text: "[飞书] 顺便看下 CI" }), { state: "answered", answer: "CI 是绿的；X 也做完了。" });
  // The same message carried in with a tool's result.
  const tucked = [user("把 X 做完"), toolCall(), toolResult({ type: "text", text: "[飞书] 顺便看下 CI" }), toolCall(), toolResult(), said("CI 是绿的。")];
  assert.deepEqual(claudeChatAnswer(tucked, { text: "[飞书] 顺便看下 CI" }), { state: "answered", answer: "CI 是绿的。" });
});

test("a turn not answered yet is open; a reminder in a user record does not end it", () => {
  const records = [
    user("[飞书] 跑一下测试"),
    toolCall("我跑一下"),
    toolResult(),
    user([{ type: "text", text: "<system-reminder>The task list changed.</system-reminder>" }]),
  ];
  assert.deepEqual(claudeChatAnswer(records, { text: "[飞书] 跑一下测试" }), { state: "open" });
  records.push(toolCall(), toolResult(), said("测试全过了。"));
  assert.deepEqual(claudeChatAnswer(records, { text: "[飞书] 跑一下测试" }), { state: "answered", answer: "测试全过了。" });
  // A message the record does not have (yet, or in another session).
  assert.deepEqual(claudeChatAnswer(records, { text: "[飞书] 别的" }), { state: "missing" });
});

test("a turn cut short by the next input answers with what it last said", () => {
  const records = [user("[飞书] 看下日志"), toolCall("日志里有两个 503，我再查一下。"), toolResult(), notification("orch-x done")];
  assert.deepEqual(claudeChatAnswer(records, { text: "[飞书] 看下日志" }), {
    state: "answered",
    answer: "日志里有两个 503，我再查一下。",
  });
  const silent = [user("[飞书] 看下日志"), toolCall(), toolResult(), user("算了")];
  assert.deepEqual(claudeChatAnswer(silent, { text: "[飞书] 看下日志" }), { state: "empty" });
});

test("two messages are each answered by their own turn, and a repeat by the one after it was sent", () => {
  const first = user("[飞书] 进度？");
  const records = [first, said("进度：都在跑。"), notification("orch-a"), said("orch-a 没变化"), user("[飞书] 进度？"), said("进度：orch-a 完成了。")];
  assert.equal(claudeChatAnswer(records, { text: "[飞书] 进度？" }).answer, "进度：都在跑。");
  const sentLater = Date.parse(records[4].timestamp);
  assert.equal(claudeChatAnswer(records, { text: "[飞书] 进度？", after: sentLater }).answer, "进度：orch-a 完成了。");
  assert.equal(claudeChatAnswer([user("[飞书] A"), said("答 A"), user("[飞书] B"), said("答 B")], { text: "[飞书] B" }).answer, "答 B");
});

// Codex 0.166: the message is a `response_item` user message, its task closes
// with `task_complete`. One sent while a task ran joined that task.
function codex(type, payload = {}) {
  return { timestamp: at(), type, payload };
}
const codexUser = (text) => codex("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const codexEvent = (type, extra = {}) => codex("event_msg", { type, ...extra });

test("Codex: the task the message belongs to, also when it came in mid-task", () => {
  const ownTask = [
    codexEvent("task_started"),
    codexUser("[飞书] 进度？"),
    codex("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "进度：都在跑。" }] }),
    codexEvent("task_complete", { last_agent_message: "进度：都在跑。" }),
    codexEvent("task_started"),
    codexUser("终端里的下一条"),
    codexEvent("task_complete", { last_agent_message: "下一条的回答" }),
  ];
  assert.deepEqual(codexChatAnswer(ownTask, { text: "[飞书] 进度？" }), { state: "answered", answer: "进度：都在跑。" });

  const midTask = [
    codexEvent("task_started"),
    codexUser("写一篇散文"),
    codexUser("[飞书] 写完只回复 OK2"),
    codexEvent("task_complete", { last_agent_message: "OK2" }),
  ];
  assert.deepEqual(codexChatAnswer(midTask, { text: "[飞书] 写完只回复 OK2" }), { state: "answered", answer: "OK2" });

  assert.deepEqual(codexChatAnswer([codexEvent("task_started"), codexUser("[飞书] 进度？")], { text: "[飞书] 进度？" }), { state: "open" });
  assert.deepEqual(
    codexChatAnswer([codexUser("[飞书] 进度？"), codexEvent("turn_aborted")], { text: "[飞书] 进度？" }),
    { state: "empty" },
  );
});

// ---------------------------------------------------------------------------
// The main session's done end to end: the waiting list, the session file on
// disk as Claude Code (or Codex) keeps it, herdr naming the pane's session,
// and a fake channel that records what goes out.

const MAIN = "w1Z:p1";
const SESSION = "c42a11a3-0000-4000-8000-000000000001";
const RELAY = roleSettings({ MAIN_AGENT_NAME: "drover", MAIN_DONE_PING: "relay" });
const ALWAYS = roleSettings({ MAIN_AGENT_NAME: "drover" });

function withSession(agent, body) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-chat-"));
    const previous = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") };
    const file =
      agent === "codex"
        ? join(dir, "codex", "sessions", "2026", "11", "08", `rollout-2026-11-08T08-50-00-${SESSION}.jsonl`)
        : join(dir, "claude", "projects", "-Users-fangtao-Git-Repo", `${SESSION}.jsonl`);
    mkdirSync(join(file, ".."), { recursive: true });
    const write = (records) => writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const run = (args) =>
      args[0] === "agent" && args[1] === "get"
        ? {
            status: 0,
            stdout: JSON.stringify({
              result: { agent: { agent, name: "drover", pane_id: MAIN, agent_session: { agent, kind: "id", value: SESSION } } },
            }),
          }
        : { status: 1, stdout: "" };
    try {
      await body({ write, run, env });
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

function channelRecorder() {
  const sent = [];
  let id = 0;
  const send = async (channel, text, options) => {
    sent.push({ channel, text, replyTo: options.replyTo });
    return `om_out_${++id}`;
  };
  return { sent, send };
}

const quietLog = () => {};

function done(deps, settings, turnAnswer) {
  return mainDonePings({ paneId: MAIN, where: "Git-Repo · pane 1", turnAnswer, settings, wait: async () => {}, log: quietLog, ...deps });
}

function deliver(pings, send) {
  return sendMainPings(pings, { paneId: MAIN, where: "Git-Repo · pane 1", title: "done · Claude", channels: ["feishu"], send, log: quietLog, error: quietLog });
}

test(
  "the done after a Monitor turn still sends the chat turn's answer, as a reply, with nothing around it",
  withSession("claude", async ({ write, run, env }) => {
    rememberPendingAnswer({ id: "q1", paneId: MAIN, channel: "feishu", messageId: "om_q", text: ASKED }, T0);
    write(chatThenMonitor());
    const out = channelRecorder();
    const pings = await done({ run, env }, RELAY, MONITOR_TURN);
    await deliver(pings, out.send);
    assert.deepEqual(out.sent, [{ channel: "feishu", text: ANSWER, replyTo: "om_q" }]);
    // Bare: no "done · Claude" title, no location line.
    assert.ok(!out.sent[0].text.includes("done · Claude") && !out.sent[0].text.includes("Git-Repo · pane 1"));
    assert.deepEqual(pendingAnswers(MAIN), []);
    // A reply to the answer is a prompt for the main session, as before.
    assert.equal(lookupOutbound("om_out_1").status, "done");
    assert.equal(lookupOutbound("om_out_1").layout, "main");
    // Nothing is waiting any more, and the Monitor turn itself stays quiet.
    assert.deepEqual(await done({ run, env }, RELAY, MONITOR_TURN), []);
    // With MAIN_DONE_PING=always that turn goes out too, on its own.
    rememberPendingAnswer({ id: "q2", paneId: MAIN, channel: "feishu", messageId: "om_q", text: ASKED }, T0);
    assert.deepEqual(
      (await done({ run, env }, ALWAYS, MONITOR_TURN)).map((ping) => [ping.kind, ping.text]),
      [
        ["chat", ANSWER],
        ["done", MONITOR_TURN],
      ],
    );
  }),
);

test(
  "a chat turn not answered yet waits for a later done, then goes out",
  withSession("claude", async ({ write, run, env }) => {
    rememberPendingAnswer({ id: "q1", paneId: MAIN, channel: "feishu", messageId: "om_q", text: "[飞书] 跑一下测试" }, T0);
    const records = [user("[飞书] 跑一下测试"), toolCall("我跑一下"), toolResult()];
    write(records);
    assert.deepEqual(await done({ run, env }, RELAY, "上一轮的回答"), []);
    assert.equal(pendingAnswers(MAIN).length, 1);

    records.push(said("测试全过了。"), notification("orch-x"), said(MONITOR_TURN));
    write(records);
    const out = channelRecorder();
    await deliver(await done({ run, env }, RELAY, MONITOR_TURN), out.send);
    assert.deepEqual(out.sent, [{ channel: "feishu", text: "测试全过了。", replyTo: "om_q" }]);
    assert.deepEqual(pendingAnswers(MAIN), []);
  }),
);

test(
  "two chat messages are each answered under their own message",
  withSession("claude", async ({ write, run, env }) => {
    rememberPendingAnswer({ id: "a", paneId: MAIN, channel: "feishu", messageId: "om_a", text: "[飞书] A 怎么样" }, T0);
    rememberPendingAnswer({ id: "b", paneId: MAIN, channel: "telegram", messageId: "56", text: "[Telegram] B 怎么样" }, T0);
    write([user("[飞书] A 怎么样"), said("A 好了。"), user("[Telegram] B 怎么样"), said("B 还在跑。"), notification("orch-a"), said(MONITOR_TURN)]);
    const out = channelRecorder();
    await sendMainPings(await done({ run, env }, RELAY, MONITOR_TURN), {
      paneId: MAIN,
      where: "Git-Repo · pane 1",
      title: "done · Claude",
      channels: ["feishu", "telegram"],
      send: out.send,
      paired: () => true,
      log: quietLog,
      error: quietLog,
    });
    // Each back on the chat it came from.
    assert.deepEqual(out.sent, [
      { channel: "feishu", text: "A 好了。", replyTo: "om_a" },
      { channel: "telegram", text: "B 还在跑。", replyTo: "56" },
    ]);
  }),
);

test(
  "a relay goes out on its own beside a chat answer; a quiet turn sends nothing",
  withSession("claude", async ({ write, run, env }) => {
    write([said("无关")]);
    assert.deepEqual(await done({ run, env }, RELAY, "内部处理完了"), []);
    const out = channelRecorder();
    await deliver(await done({ run, env }, RELAY, "【转达】orch-voice 等你决定是否推送"), out.send);
    assert.deepEqual(out.sent, [{ channel: "feishu", text: "【转达】orch-voice 等你决定是否推送", replyTo: undefined }]);
  }),
);

test(
  "Codex: the answer of the task the message started",
  withSession("codex", async ({ write, run, env }) => {
    rememberPendingAnswer({ id: "c1", paneId: MAIN, channel: "feishu", messageId: "om_c", text: "[飞书] 进度？" }, T0);
    write([
      codexEvent("task_started"),
      codexUser("[飞书] 进度？"),
      codexEvent("task_complete", { last_agent_message: "进度：都在跑。" }),
      codexEvent("task_started"),
      codexUser("终端里的下一条"),
      codexEvent("task_complete", { last_agent_message: "下一条的回答" }),
    ]);
    const out = channelRecorder();
    await deliver(await done({ run, env }, RELAY, "下一条的回答"), out.send);
    assert.deepEqual(out.sent, [{ channel: "feishu", text: "进度：都在跑。", replyTo: "om_c" }]);
  }),
);

test(
  "with no session record to look in, this turn's answer goes to the oldest message",
  withSession("claude", async ({ env }) => {
    rememberPendingAnswer({ id: "q1", paneId: MAIN, channel: "feishu", messageId: "om_q", text: ASKED }, T0);
    const noSession = () => ({ status: 1, stdout: "" });
    const pings = await done({ run: noSession, env }, RELAY, "从屏幕上读到的回答");
    assert.deepEqual(pings, [{ kind: "chat", id: "q1", text: "从屏幕上读到的回答", replyTo: { channel: "feishu", messageId: "om_q" } }]);
  }),
);
