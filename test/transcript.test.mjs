import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capAnswer,
  claudeLastAnswer,
  claudePendingCalls,
  claudeProcessSession,
  claudeSubagentFiles,
  codexLastAnswer,
  codexPendingCalls,
  ensureIntegrations,
  extractAgentSession,
  extractPanePids,
  missingIntegrations,
  paneAgentName,
  paneSession,
  pendingDialog,
  readSessionTail,
  sessionAnswer,
  sessionDialogBody,
  sessionFile,
} from "../src/lib/index.mjs";

async function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-sessions-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

// The shapes the agents write, cut down to the fields that matter.
const codex = {
  started: { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
  reply: {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "draft" }] },
  },
  complete: (text) => ({ type: "event_msg", payload: { type: "task_complete", last_agent_message: text } }),
  tokens: { type: "event_msg", payload: { type: "token_count" } },
};

const claude = {
  prompt: (text) => ({ type: "user", message: { role: "user", content: text } }),
  assistant: (blocks, stop) => ({
    type: "assistant",
    message: { role: "assistant", content: blocks, stop_reason: stop },
  }),
  toolResult: { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
  system: { type: "system" },
};

const session = (agent, kind, value) => ({ result: { agent: { pane_id: "w1:p1", agent_session: { agent, kind, source: `herdr:${agent}`, value } } } });

test("the pane's session comes from either herdr shape, and only when well formed", () => {
  assert.deepEqual(extractAgentSession(session("codex", "id", "01a1")), { agent: "codex", kind: "id", value: "01a1" });
  assert.deepEqual(
    extractAgentSession({ result: { pane: { agent_session: { agent: "claude", kind: "path", value: "/t.jsonl" } } } }),
    { agent: "claude", kind: "path", value: "/t.jsonl" },
  );
  assert.equal(extractAgentSession({ result: { agent: { pane_id: "w1:p1" } } }), undefined, "no integration, no session");
  assert.equal(extractAgentSession(session("codex", "url", "x")), undefined);
  assert.equal(extractAgentSession(session("codex", "id", "")), undefined);

  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    return { status: 0, stdout: JSON.stringify(session("codex", "id", "01a1")) };
  };
  assert.deepEqual(paneSession("w1:p1", { run }), { agent: "codex", kind: "id", value: "01a1" });
  assert.deepEqual(calls, ["agent get w1:p1"]);
});

// `herdr pane process-info` as Herdr prints it, cut down: the group leader is
// the agent, the rest are its helpers.
const PROCESS_INFO = {
  result: {
    process_info: {
      foreground_process_group_id: 44426,
      foreground_processes: [
        { argv0: "caffeinate", name: "caffeinate", pid: 61422 },
        { argv0: "claude", name: "2.1.301", pid: 44426 },
      ],
      pane_id: "wN:p1",
      shell_pid: 24782,
    },
    type: "pane_process_info",
  },
};

test("a Claude pane is tied to its session through Claude Code's own process record", async () => {
  assert.deepEqual(extractPanePids(PROCESS_INFO), [44426, 61422]);
  await withHome(async (home) => {
    mkdirSync(join(home, "sessions"));
    writeFileSync(
      join(home, "sessions", "44426.json"),
      JSON.stringify({ pid: 44426, sessionId: "f5d4ce09-9f6b", cwd: "/repo", kind: "interactive" }),
    );
    const env = { CLAUDE_CONFIG_DIR: home };
    assert.deepEqual(claudeProcessSession([44426, 61422], env), { agent: "claude", kind: "id", value: "f5d4ce09-9f6b" });
    assert.equal(claudeProcessSession([61422], env), undefined, "no record for a helper process");

    // No integration reported a session; Herdr only knows the pane runs Claude.
    const calls = [];
    const run = (args) => {
      calls.push(args.join(" "));
      if (args[1] === "process-info") {
        return { status: 0, stdout: JSON.stringify(PROCESS_INFO) };
      }
      return { status: 0, stdout: JSON.stringify({ result: { agent: { agent: "claude", pane_id: "wN:p1" } } }) };
    };
    assert.deepEqual(paneSession("wN:p1", { run, env }), { agent: "claude", kind: "id", value: "f5d4ce09-9f6b" });
    assert.ok(calls.includes("pane process-info --pane wN:p1"));

    // A one-shot `claude -p` a tool started is not the conversation.
    writeFileSync(join(home, "sessions", "44426.json"), JSON.stringify({ sessionId: "x-1", kind: "print" }));
    assert.equal(claudeProcessSession([44426], env), undefined);
  });
});

test("a Codex pane with no reported session is left to the screen", () => {
  const run = (args) =>
    args[1] === "process-info"
      ? { status: 0, stdout: JSON.stringify(PROCESS_INFO) }
      : { status: 0, stdout: JSON.stringify({ result: { agent: { agent: "codex", pane_id: "wN:p1" } } }) };
  assert.equal(paneSession("wN:p1", { run }), undefined);
  // …and named as Codex, which is what lets the done hook put the integration
  // in for the sessions that come after it.
  assert.equal(paneAgentName("wN:p1", run), "codex");
  assert.equal(paneAgentName("wN:p1", () => ({ status: 1, stdout: "" })), undefined);
});

test("a Claude session already running before any setup still yields its answer", async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, "sessions"));
    mkdirSync(join(home, "projects", "-repo"), { recursive: true });
    writeFileSync(join(home, "sessions", "44426.json"), JSON.stringify({ sessionId: "s-1", kind: "interactive" }));
    writeFileSync(
      join(home, "projects", "-repo", "s-1.jsonl"),
      jsonl([claude.prompt("go"), claude.assistant([{ type: "text", text: "Done: 3 files changed." }], "end_turn")]),
    );
    const run = (args) =>
      args[1] === "process-info"
        ? { status: 0, stdout: JSON.stringify(PROCESS_INFO) }
        : { status: 0, stdout: JSON.stringify({ result: { agent: { agent: "claude" } } }) };
    assert.equal(
      await sessionAnswer("wN:p1", { run, env: { CLAUDE_CONFIG_DIR: home }, wait: async () => {} }),
      "Done: 3 files changed.",
    );
  });
});

test("a session id leads to the agent's own file", async () => {
  await withHome((home) => {
    const claudeDir = join(home, "claude");
    mkdirSync(join(claudeDir, "projects", "-Users-me-repo"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "-Users-me-repo", "abc-123.jsonl"), "");

    const codexDir = join(home, "codex");
    mkdirSync(join(codexDir, "sessions", "2026", "10", "19"), { recursive: true });
    mkdirSync(join(codexDir, "sessions", "2026", "10", "20"), { recursive: true });
    writeFileSync(join(codexDir, "sessions", "2026", "10", "19", "rollout-2026-10-19T16-09-57-01a1-old.jsonl"), "");
    // A fork names its parent first; looking up the parent must not land here.
    writeFileSync(join(codexDir, "sessions", "2026", "10", "20", "rollout-2026-10-20T15-52-29-01a1-old_01a1-new.jsonl"), "");

    const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
    assert.match(sessionFile({ agent: "claude", kind: "id", value: "abc-123" }, env), /-Users-me-repo\/abc-123\.jsonl$/);
    assert.match(sessionFile({ agent: "codex", kind: "id", value: "01a1-old" }, env), /10\/19\/rollout-.*-01a1-old\.jsonl$/);
    assert.match(sessionFile({ agent: "codex", kind: "id", value: "01a1-new" }, env), /10\/20\/rollout-.*_01a1-new\.jsonl$/);
    assert.equal(sessionFile({ agent: "codex", kind: "id", value: "missing" }, env), undefined);
    assert.equal(sessionFile({ agent: "codex", kind: "id", value: "../../etc/passwd" }, env), undefined);
    assert.equal(sessionFile({ agent: "pi", kind: "id", value: "abc-123" }, env), undefined);

    const path = join(claudeDir, "projects", "-Users-me-repo", "abc-123.jsonl");
    assert.equal(sessionFile({ agent: "claude", kind: "path", value: path }, env), path);
    assert.equal(sessionFile({ agent: "claude", kind: "path", value: join(home, "gone.jsonl") }, env), undefined);
  });
});

test("Codex's answer is the last task_complete, and only once the turn is written", () => {
  assert.equal(
    codexLastAnswer([codex.started, codex.reply, codex.complete("相较 1.4.0 标签，主要更新：\n• 支持多个账号切换"), codex.tokens]),
    "相较 1.4.0 标签，主要更新：\n• 支持多个账号切换",
  );
  // The next turn has started and not finished: its answer is not in the file
  // yet, and the previous turn's must not stand in for it.
  assert.equal(codexLastAnswer([codex.started, codex.complete("old"), codex.started, codex.reply]), undefined);
  assert.equal(codexLastAnswer([codex.started, codex.complete("")]), undefined);
  assert.equal(codexLastAnswer([]), undefined);
});

test("Claude's answer is the closing message, without the narration before its tool calls", () => {
  const records = [
    claude.prompt("summarise the release"),
    claude.assistant([{ type: "text", text: "I'll read the changelog first." }], "tool_use"),
    claude.assistant([{ type: "tool_use", name: "Read" }], "tool_use"),
    claude.toolResult,
    claude.assistant([{ type: "thinking", thinking: "…" }], "end_turn"),
    claude.assistant([{ type: "text", text: "Three changes since 1.0.2:" }], "end_turn"),
    claude.assistant([{ type: "text", text: "- faster sync" }], "end_turn"),
    claude.system,
    // A subagent's records are not the turn.
    { ...claude.assistant([{ type: "text", text: "subagent chatter" }], "end_turn"), isSidechain: true },
  ];
  assert.equal(claudeLastAnswer(records), "Three changes since 1.0.2:\n\n- faster sync");
  // Still running: a tool result came back and nothing has answered it yet.
  assert.equal(claudeLastAnswer(records.slice(0, 4)), undefined);
  assert.equal(claudeLastAnswer([claude.prompt("next")]), undefined);
});

test("only the end of a long session file is read, without its cut first line", async () => {
  await withHome((home) => {
    const path = join(home, "s.jsonl");
    const filler = { type: "event_msg", payload: { type: "token_count", pad: "x".repeat(200) } };
    writeFileSync(path, jsonl([...Array(50).fill(filler), codex.started, codex.complete("done")]));
    const records = readSessionTail(path, 1024);
    assert.ok(records.length < 52, "not the whole file");
    assert.ok(records.every((record) => record && typeof record === "object"));
    assert.equal(codexLastAnswer(records), "done");
    assert.deepEqual(readSessionTail(join(home, "missing.jsonl")), []);
  });
});

test("the answer is read again while the agent finishes writing the turn", async () => {
  await withHome(async (home) => {
    const codexDir = join(home, "codex");
    const day = join(codexDir, "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout-2026-10-20T15-53-18-01a1584c.jsonl");
    writeFileSync(path, jsonl([codex.complete("previous turn"), codex.started, codex.reply]));
    const run = () => ({ status: 0, stdout: JSON.stringify(session("codex", "id", "01a1584c")) });
    const waits = [];
    const answer = await sessionAnswer("w1:p1", {
      run,
      env: { CODEX_HOME: codexDir },
      wait: async (ms) => {
        waits.push(ms);
        // The turn lands in the file while the hook is waiting.
        appendFileSync(path, jsonl([codex.complete("this turn")]));
      },
    });
    assert.equal(answer, "this turn", "never the previous turn's answer");
    assert.deepEqual(waits, [500]);
  });
});

test("no reported session, or a turn that never lands, leaves it to the screen", async () => {
  const noSession = () => ({ status: 0, stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p1" } } }) });
  assert.equal(await sessionAnswer("w1:p1", { run: noSession, wait: async () => {} }), undefined);

  await withHome(async (home) => {
    const day = join(home, "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-x-01a1.jsonl"), jsonl([codex.started]));
    const run = () => ({ status: 0, stdout: JSON.stringify(session("codex", "id", "01a1")) });
    const waits = [];
    const answer = await sessionAnswer("w1:p1", {
      run,
      env: { CODEX_HOME: home },
      attempts: 3,
      wait: async (ms) => waits.push(ms),
    });
    assert.equal(answer, undefined);
    assert.equal(waits.length, 2, "bounded retries");
  });
});

test("a long answer keeps its beginning", () => {
  assert.equal(capAnswer("short"), "short");
  const long = `${"a".repeat(3000)}${"b".repeat(1000)}`;
  const capped = capAnswer(long);
  assert.ok(capped.startsWith("aaa"));
  assert.ok(capped.endsWith("\n…"));
  assert.ok(capped.length <= 3203);
});

test("only Codex is installed for, only when this machine uses it, and only when missing", async () => {
  await withHome((home) => {
    const status = (codex) =>
      [
        "pi: not installed (/x/.pi/agent/extensions/herdr-agent-state.ts)",
        "claude: not installed (/x/.claude/hooks/herdr-agent-state.sh)",
        `codex: ${codex} (/x/.codex/herdr-agent-state.sh)`,
      ].join("\n");
    const env = { HOME: home };
    // ~/.codex does not exist yet: Codex is not in use here.
    assert.deepEqual(missingIntegrations({ run: () => ({ status: 0, stdout: status("not installed") }), env }), []);

    mkdirSync(join(home, ".codex"));
    // Claude Code is never asked for: its own process record is enough.
    assert.deepEqual(missingIntegrations({ run: () => ({ status: 0, stdout: status("not installed") }), env }), ["codex"]);
    assert.deepEqual(missingIntegrations({ run: () => ({ status: 0, stdout: status("outdated (v4)") }), env }), ["codex"]);
    assert.deepEqual(missingIntegrations({ run: () => ({ status: 0, stdout: status("current (v10)") }), env }), []);
    assert.deepEqual(missingIntegrations({ run: () => ({ status: 1, stdout: "" }), env }), []);
  });
});

test("the Codex integration is installed for the user, unless they said not to", async () => {
  await withHome((home) => {
    mkdirSync(join(home, ".codex"));
    const env = { HOME: home };
    const calls = [];
    const run = (args) => {
      calls.push(args.join(" "));
      if (args[1] === "status") {
        return { status: 0, stdout: "codex: not installed (/x)" };
      }
      return { status: 0, stdout: "installed codex integration hook" };
    };
    assert.deepEqual(ensureIntegrations({ run, env, enabled: true }), { installed: ["codex"], failed: [] });
    assert.deepEqual(calls, ["integration status", "integration install codex"]);

    const refused = ensureIntegrations({
      run: (args) => (args[1] === "status" ? { status: 0, stdout: "codex: not installed (/x)" } : { status: 1, stderr: "no codex dir" }),
      env,
      enabled: true,
    });
    assert.deepEqual(refused, { installed: [], failed: [{ agent: "codex", detail: "no codex dir" }] });

    const untouched = [];
    assert.deepEqual(ensureIntegrations({ run: (args) => untouched.push(args) && {}, env, enabled: false }), {
      installed: [],
      failed: [],
    });
    assert.deepEqual(untouched, [], "INSTALL_AGENT_INTEGRATION=0 means no herdr call at all");
  });
});

// --- blocked: the dialog's subject from the session -------------------------

const LONG_COMMAND = "rm -rf -- build/ && npm run build && npm run test:e2e -- --grep checkout --reporter=dot --retries=2 --workers=4";

const bashUse = (id, command, description) => ({
  type: "tool_use",
  id,
  name: "Bash",
  input: { command, description },
});

// What Claude Code draws for that call: the command cut at the pane's width.
const BASH_DIALOG = [
  "⏺ Bash(rm -rf -- build/ && npm run build && npm run test:e2e -- --grep checkout…)",
  "",
  " Bash command",
  "",
  "   rm -rf -- build/ && npm run build && npm run test:e2e -- --grep checkout …",
  "   Rebuild and run the checkout e2e suite",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for npm run commands in /repo",
  "   3. No, and tell Claude what to do differently (esc)",
].join("\n");

test("Claude's open calls are the ones in this turn with no result yet", () => {
  const prompt = claude.prompt("rebuild and test");
  const calls = claudePendingCalls([
    prompt,
    claude.assistant([{ type: "text", text: "Rebuilding." }, bashUse("t1", "ls build"), bashUse("t2", LONG_COMMAND)], "tool_use"),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  ]);
  assert.deepEqual(calls.map((call) => call.input.command), [LONG_COMMAND]);
  // An earlier turn's call is not this turn's, answered or not.
  assert.deepEqual(claudePendingCalls([claude.assistant([bashUse("old", "rm -rf /tmp/x")], "tool_use"), prompt]), []);
  assert.deepEqual(claudePendingCalls([prompt, claude.assistant([{ type: "text", text: "done" }], "end_turn")]), []);
});

test("Codex's open calls are this turn's calls with no output", () => {
  const call = (id, name, args) => ({ type: "response_item", payload: { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) } });
  const output = (id) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: "ok" } });
  const records = [
    codex.started,
    call("c1", "exec_command", { cmd: "ls" }),
    output("c1"),
    call("c2", "exec_command", { cmd: "git push --force", workdir: "/repo", justification: "Publish the fix" }),
  ];
  assert.deepEqual(codexPendingCalls(records), [
    { name: "exec_command", input: { cmd: "git push --force", workdir: "/repo", justification: "Publish the fix" } },
  ]);
  assert.deepEqual(codexPendingCalls([...records, output("c2"), codex.complete("pushed")]), []);
});

test("the dialog's body is the whole call, and only the call that is on screen", () => {
  const records = [
    claude.prompt("go"),
    claude.assistant([bashUse("t1", "git status"), bashUse("t2", LONG_COMMAND, "Rebuild and run the checkout e2e suite")], "tool_use"),
  ];
  const found = pendingDialog("claude", records, BASH_DIALOG);
  assert.equal(found.text, `Bash · Rebuild and run the checkout e2e suite\n${LONG_COMMAND}`, "the command the screen cut short, whole");
  // Neither open call is what this dialog asks about: nothing from the session.
  const other = BASH_DIALOG.replaceAll("rm -rf -- build/ && npm run build && npm run test:e2e -- --grep checkout", "curl -X DELETE https://api");
  assert.equal(pendingDialog("claude", records, other), undefined);
});

test("a form's body is the question on screen, with every option's description", () => {
  const ask = {
    type: "tool_use",
    id: "q1",
    name: "AskUserQuestion",
    input: {
      questions: [
        { question: "Where should the result card go?", options: [{ label: "Inline", description: "In the thread" }, { label: "Pinned" }] },
        {
          question: "What should happen to the re-send button?",
          options: [
            { label: "Drop it", description: "A failed send gets a per-message retry instead, so the hover button has nothing left to do" },
            { label: "Keep it" },
          ],
        },
      ],
    },
  };
  const records = [claude.prompt("design it"), claude.assistant([ask], "tool_use")];
  // The form's second tab is the one up now.
  const screen = [
    "←  ☒ Result card  ☐ Resend  ✔ Submit  →",
    "",
    "What should happen to the re-send button?",
    "",
    "❯ 1. Drop it",
    "     A failed send gets a per-message retry instead, so the hover button",
    "  2. Keep it",
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
  const found = pendingDialog("claude", records, screen);
  assert.equal(
    found.text,
    "What should happen to the re-send button?\n\n1. Drop it — A failed send gets a per-message retry instead, so the hover button has nothing left to do\n2. Keep it",
  );
});

test("Codex's code-mode exec is left to the screen; its plain calls are not", () => {
  const custom = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "x1", input: 'text(await tools.exec_command({cmd:"git push --force"}))' } };
  const screen = "Would you like to run the following command?\n\n  $ git push --force\n\n› 1. Yes, proceed (y)\n  2. No (esc)";
  assert.equal(pendingDialog("codex", [codex.started, custom], screen), undefined);

  const plain = {
    type: "response_item",
    payload: { type: "function_call", name: "exec_command", call_id: "x2", arguments: JSON.stringify({ cmd: "git push --force", workdir: "/repo" }) },
  };
  assert.equal(pendingDialog("codex", [codex.started, plain], screen).text, "Run\ngit push --force\nin /repo");
});

test("a blocked body is read from the pane's session, with the screen's question under it", async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, "sessions"));
    mkdirSync(join(home, "projects", "-repo"), { recursive: true });
    writeFileSync(join(home, "sessions", "44426.json"), JSON.stringify({ sessionId: "s-2", kind: "interactive" }));
    writeFileSync(
      join(home, "projects", "-repo", "s-2.jsonl"),
      jsonl([claude.prompt("go"), claude.assistant([bashUse("t1", LONG_COMMAND, "Rebuild and run the checkout e2e suite")], "tool_use")]),
    );
    const run = (args) =>
      args[1] === "process-info"
        ? { status: 0, stdout: JSON.stringify(PROCESS_INFO) }
        : { status: 0, stdout: JSON.stringify({ result: { agent: { agent: "claude" } } }) };
    const env = { CLAUDE_CONFIG_DIR: home };
    assert.equal(
      sessionDialogBody("wN:p1", BASH_DIALOG, { run, env }),
      `Bash · Rebuild and run the checkout e2e suite\n${LONG_COMMAND}\n\nDo you want to proceed?`,
    );
    // A pane whose session cannot be found leaves it to the screen.
    assert.equal(sessionDialogBody("wN:p1", BASH_DIALOG, { run: () => ({ status: 1 }), env }), undefined);
  });
});

// Reconstructed from a screenshot of a dialog a background subagent raised
// (names and paths changed). Its ping carried only the part below the second
// dashed rule — no command — because the subagent's calls live in their own
// transcript and the session's was the only one read.
const GREP = String.raw`grep -n "^import.*@/i18n\|^import i18n\|^import appI18n" 'src/routes/skills.create.$type.tsx' src/routes/skills.index.tsx; grep -n "formatQuotaExhausted" 'src/routes/skills.create.$type.tsx' | head -3`;
const SUBAGENT_DIALOG = [
  "─".repeat(100),
  " Bash command · from the code-writer agent                                                      2 of 3",
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  " Check i18n imports in skills routes",
  "╌".repeat(100),
  String.raw` │ grep -n "^import.*@/i18n\|^import i18n\|^import appI18n" 'src/routes/skills.create.$type.tsx' src/routes/skills.index.tsx; grep -n`,
  ` │ "formatQuotaExhausted" 'src/routes/skills.create.$type.tsx' | head -3`,
  "╌".repeat(100),
  " Shell expansion syntax in paths requires manual approval",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow reading from /Users/me/acme/app/src/routes from this project",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents",
].join("\n");

const sidechain = (record) => ({ ...record, isSidechain: true });

test("a subagent's dialog is read from the subagent's own transcript", async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, "sessions"));
    const project = join(home, "projects", "-repo");
    const subagents = join(project, "s-4", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(home, "sessions", "44426.json"), JSON.stringify({ sessionId: "s-4", kind: "interactive" }));
    // The main session: its open call is the Agent that started a subagent,
    // which is never what a permission dialog is about.
    writeFileSync(
      join(project, "s-4.jsonl"),
      jsonl([
        claude.prompt("build the points UI"),
        claude.assistant([{ type: "tool_use", id: "a1", name: "Agent", input: { description: "User-facing UI", subagent_type: "code-writer" } }], "tool_use"),
      ]),
    );
    // Two subagents with a dialog each queued ("2 of 3"): the one on screen wins.
    writeFileSync(
      join(subagents, "agent-one.jsonl"),
      jsonl([sidechain(claude.prompt("UI task")), sidechain(claude.assistant([bashUse("b1", GREP, "Check i18n imports in skills routes")], "tool_use"))]),
    );
    writeFileSync(join(subagents, "agent-one.meta.json"), JSON.stringify({ agentType: "code-writer" }));
    writeFileSync(
      join(subagents, "agent-two.jsonl"),
      jsonl([sidechain(claude.prompt("tests")), sidechain(claude.assistant([bashUse("b2", "npm run test -- quota", "Run the quota tests")], "tool_use"))]),
    );
    writeFileSync(join(subagents, "agent-two.meta.json"), JSON.stringify({ agentType: "test-writer" }));

    const run = (args) =>
      args[1] === "process-info"
        ? { status: 0, stdout: JSON.stringify(PROCESS_INFO) }
        : { status: 0, stdout: JSON.stringify({ result: { agent: { agent: "claude" } } }) };
    assert.equal(
      sessionDialogBody("wN:p1", SUBAGENT_DIALOG, { run, env: { CLAUDE_CONFIG_DIR: home } }),
      `Bash · Check i18n imports in skills routes · from the code-writer agent\n${GREP}\n\nDo you want to proceed?`,
    );
    assert.equal(claudeSubagentFiles(join(project, "s-4.jsonl")).length, 2);
  });
});

test("a tool with nothing to show is never matched by its name alone", () => {
  // "agent" is on the screen of every subagent dialog; the Agent call is not
  // what it asks about.
  const records = [claude.prompt("go"), claude.assistant([{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: "x" } }], "tool_use")];
  assert.equal(pendingDialog("claude", records, SUBAGENT_DIALOG), undefined);
  const mcp = [claude.prompt("go"), claude.assistant([{ type: "tool_use", id: "m1", name: "mcp__db__execute_sql", input: { query: "select 1" } }], "tool_use")];
  assert.match(pendingDialog("claude", mcp, "db - execute_sql (MCP)\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No").text, /^mcp__db__execute_sql\n/);
});
