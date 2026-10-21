import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { envFlag } from "./config.mjs";
import { dialogQuestion } from "./format.mjs";
import { runHerdr, sleep } from "./paths.mjs";

// A done ping carries the agent's last answer, and the agent's own session
// record has that answer verbatim. Reading it off the screen instead meant
// guessing which lines were the answer and which were whatever the agent draws
// around it, and every new footer an agent grew put that footer into the ping.
//
// Getting from a pane to its session takes no setup from the user:
// - Claude Code keeps a record per running process, `~/.claude/sessions/<pid>.json`
//   with its `sessionId`, and Herdr names the pane's processes. Exact, and it
//   works for a session that was already running.
// - Codex keeps nothing per process (its terminal hands the session to a
//   background server), so it relies on Herdr's integration, which reports the
//   session on SessionStart via `pane.report_agent_session`; `ensureIntegrations`
//   installs it for the user.

// `agent get` / `pane get` carry it as
// `agent_session: { agent, kind: "id" | "path", source, value }`.
export function extractAgentSession(payload) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    for (const candidate of [root.agent_session, root.agent?.agent_session, root.pane?.agent_session]) {
      if (
        candidate &&
        typeof candidate.agent === "string" &&
        (candidate.kind === "id" || candidate.kind === "path") &&
        typeof candidate.value === "string" &&
        candidate.value
      ) {
        return { agent: candidate.agent, kind: candidate.kind, value: candidate.value };
      }
    }
  }
  return undefined;
}

// Which agent Herdr detected in the pane ("claude", "codex", …).
export function extractAgentName(payload) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    for (const value of [root.agent?.agent, root.pane?.agent, typeof root.agent === "string" ? root.agent : undefined]) {
      if (typeof value === "string" && value) {
        return value;
      }
    }
  }
  return undefined;
}

function herdrJson(args, run) {
  const result = run(args);
  if (result?.error || result?.status !== 0 || !result?.stdout?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

// The pane's process group leader first, then every foreground process: an
// agent started through a wrapper is not the group leader.
export function extractPanePids(payload) {
  const info = payload?.result?.process_info ?? payload?.process_info ?? payload?.result ?? {};
  const pids = [info.foreground_process_group_id, ...(info.foreground_processes ?? []).map((item) => item?.pid)];
  return [...new Set(pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 1))];
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// `~/.claude/sessions/<pid>.json` is Claude Code's own record of what each
// running process is doing; `sessionId` follows a /clear or a resume. A
// one-shot `claude -p` a tool started in the pane is not the session the user
// is talking to, hence the interactive check.
export function claudeProcessSession(pids, env = process.env) {
  const dir = join(claudeHome(env), "sessions");
  for (const pid of pids) {
    const record = readJsonFile(join(dir, `${pid}.json`));
    if (
      record &&
      typeof record.sessionId === "string" &&
      /^[\w-]+$/.test(record.sessionId) &&
      (record.kind === undefined || record.kind === "interactive")
    ) {
      return { agent: "claude", kind: "id", value: record.sessionId };
    }
  }
  return undefined;
}

// The agent Herdr detected in the pane, or undefined.
export function paneAgentName(paneId, run = runHerdr) {
  for (const args of [
    ["agent", "get", paneId],
    ["pane", "get", paneId],
  ]) {
    const name = extractAgentName(herdrJson(args, run));
    if (name) {
      return name;
    }
  }
  return undefined;
}

// The session a pane runs: the one Herdr's integration reported, else, for
// Claude Code, the one its process record names.
export function paneSession(paneId, { run = runHerdr, env = process.env } = {}) {
  if (!paneId) {
    return undefined;
  }
  let agent;
  for (const args of [
    ["agent", "get", paneId],
    ["pane", "get", paneId],
  ]) {
    const payload = herdrJson(args, run);
    const session = extractAgentSession(payload);
    if (session) {
      return session;
    }
    agent ??= extractAgentName(payload);
  }
  if (agent === "claude") {
    const pids = extractPanePids(herdrJson(["pane", "process-info", "--pane", paneId], run));
    return claudeProcessSession(pids, env);
  }
  return undefined;
}

function claudeHome(env) {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

function codexHome(env) {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

function listDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// Claude Code keeps `projects/<encoded cwd>/<session id>.jsonl`. Its hook
// reports the path too, but a pane can also arrive here with only the id.
function claudeSessionFile(id, env) {
  const projects = join(claudeHome(env), "projects");
  for (const project of listDir(projects)) {
    const path = join(projects, project, `${id}.jsonl`);
    if (existsSync(path)) {
      return path;
    }
  }
  return undefined;
}

// Codex keeps `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, and a forked
// session `rollout-<time>-<parent>_<id>.jsonl`. Its hook reports only the id.
// Newest dates first: the session a pane is running is almost always recent.
function codexSessionFile(id, env) {
  const sessions = join(codexHome(env), "sessions");
  const newestFirst = (path) => listDir(path).sort().reverse();
  const ending = new RegExp(`[-_]${id.replace(/[^\w-]/g, "")}\\.jsonl$`);
  for (const year of newestFirst(sessions)) {
    for (const month of newestFirst(join(sessions, year))) {
      for (const day of newestFirst(join(sessions, year, month))) {
        const hit = listDir(join(sessions, year, month, day)).find((name) => ending.test(name));
        if (hit) {
          return join(sessions, year, month, day, hit);
        }
      }
    }
  }
  return undefined;
}

export function sessionFile(session, env = process.env) {
  if (!session) {
    return undefined;
  }
  if (session.kind === "path") {
    return existsSync(session.value) ? session.value : undefined;
  }
  // An id is a file name component here; anything but a plain id is refused
  // rather than joined into a path.
  if (!/^[\w-]+$/.test(session.value)) {
    return undefined;
  }
  if (session.agent === "claude") {
    return claudeSessionFile(session.value, env);
  }
  if (session.agent === "codex") {
    return codexSessionFile(session.value, env);
  }
  return undefined;
}

// The agents that need Herdr's integration to tie a pane to its session and
// do not have it. Only Codex does: Claude Code keeps its own per-process
// record. An agent whose config directory does not exist is not in use here,
// and Herdr's install needs that directory anyway. Any status but current or
// installed (missing, outdated) counts as missing.
export function missingIntegrations({ run = runHerdr, env = process.env } = {}) {
  const result = run(["integration", "status"]);
  if (result?.error || result?.status !== 0 || !result?.stdout) {
    return [];
  }
  const homes = { codex: codexHome(env) };
  const lines = result.stdout.split("\n");
  return Object.entries(homes)
    .filter(([agent, home]) => {
      const line = lines.find((item) => item.startsWith(`${agent}:`));
      return Boolean(line) && !/:\s*(?:current|installed)\b/.test(line) && existsSync(home);
    })
    .map(([agent]) => agent);
}

// Installs what `missingIntegrations` names, so no user has to. It is Herdr's
// own integration, the one Herdr's docs recommend anyway; it writes a hook into
// the agent's config. `INSTALL_AGENT_INTEGRATION=0` leaves agent configs alone,
// and done pings for those panes are then read off the screen. Returns the
// agents installed and the ones that failed.
export function ensureIntegrations({
  run = runHerdr,
  env = process.env,
  enabled = envFlag("INSTALL_AGENT_INTEGRATION", true),
} = {}) {
  const outcome = { installed: [], failed: [] };
  if (!enabled) {
    return outcome;
  }
  for (const agent of missingIntegrations({ run, env })) {
    const result = run(["integration", "install", agent]);
    if (!result?.error && result?.status === 0) {
      outcome.installed.push(agent);
    } else {
      const detail = result?.stderr?.trim() || result?.error?.message || `exit ${result?.status}`;
      outcome.failed.push({ agent, detail });
    }
  }
  return outcome;
}

// Session files grow for as long as the session lives; the last turn is at
// the end, so only the end is read.
const TAIL_BYTES = 4 * 1024 * 1024;

export function readSessionTail(path, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      // The first line was cut mid-record; drop it.
      text = text.slice(text.indexOf("\n") + 1);
    }
    return text
      .split("\n")
      .map((line) => {
        try {
          return line.trim() ? JSON.parse(line) : undefined;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

// Codex closes every turn with a `task_complete` event that carries the turn's
// final message. A `task_started` after the last of them means the turn the
// done event is about has not reached the file yet.
export function codexLastAnswer(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const type = records[i]?.type === "event_msg" ? records[i].payload?.type : undefined;
    if (type === "task_started") {
      return undefined;
    }
    if (type === "task_complete") {
      const text = records[i].payload.last_agent_message;
      return typeof text === "string" && text.trim() ? text.trim() : undefined;
    }
  }
  return undefined;
}

// Claude Code writes each content block as its own record, and every block of
// the message that ends a turn carries `stop_reason: "end_turn"`. The turn is
// written once the last conversation record is one of those; its answer is the
// text in that trailing run — narration before a tool call ends in
// `tool_use` and stays out. Subagent records (`isSidechain`) are not the turn.
export function claudeLastAnswer(records) {
  const chat = records.filter(
    (record) => (record.type === "assistant" || record.type === "user") && !record.isSidechain,
  );
  const parts = [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const record = chat[i];
    if (record.type !== "assistant" || record.message?.stop_reason !== "end_turn") {
      break;
    }
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) {
      parts.unshift(text);
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

export function lastAnswer(agent, records) {
  if (agent === "codex") {
    return codexLastAnswer(records);
  }
  if (agent === "claude") {
    return claudeLastAnswer(records);
  }
  return undefined;
}

// A message channel takes a few thousand characters comfortably. An answer is
// read from the top, so a long one keeps its beginning.
const ANSWER_LIMIT = 3200;

export function capAnswer(text, limit = ANSWER_LIMIT) {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}\n…`;
}

// The pane's last answer from its session record, or undefined when the pane
// has no session to find, the file cannot be found, or the turn never
// reaches the file in time — the caller then reads the screen as before. The
// done event can land a moment before the agent has written the turn out, so
// an unfinished file is read again a few times.
export async function sessionAnswer(
  paneId,
  { run = runHerdr, env = process.env, attempts = 6, delayMs = 500, wait = sleep } = {},
) {
  const session = paneSession(paneId, { run, env });
  const path = sessionFile(session, env);
  if (!path) {
    return undefined;
  }
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await wait(delayMs);
    }
    const answer = lastAnswer(session.agent, readSessionTail(path));
    if (answer) {
      return capAnswer(answer);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Blocked: what the dialog is about.
//
// A permission dialog is about a tool call the agent has already made: the
// call is written to the session the moment the model emits it, and its result
// only once the user has answered (a Claude Bash call approved from Feishu was
// recorded at 03:11:41 and answered at 03:13:00). So the open call is the
// dialog's subject, verbatim — the whole command rather than what fit on the
// screen. The screen still decides everything that is pressed: whether a
// dialog is up, its choices, the fingerprint. And the text is only used when a
// piece of the call is actually on screen, since a turn can have several calls
// open and the dialog asks about one of them.

// Claude Code: the tool calls in the current turn with no tool_result yet. A
// turn that ended (`end_turn` last) has none; a user prompt is where the turn
// began.
export function claudePendingCalls(records) {
  const chat = records.filter(
    (record) => (record.type === "assistant" || record.type === "user") && !record.isSidechain,
  );
  const last = chat.at(-1);
  if (last?.type === "assistant" && last.message?.stop_reason === "end_turn") {
    return [];
  }
  const answered = new Set();
  const calls = [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const blocks = Array.isArray(chat[i].message?.content) ? chat[i].message.content : [];
    if (chat[i].type === "user") {
      const results = blocks.filter((block) => block?.type === "tool_result");
      if (!results.length) {
        break;
      }
      for (const block of results) {
        answered.add(block.tool_use_id);
      }
      continue;
    }
    const open = blocks.filter((block) => block?.type === "tool_use" && !answered.has(block.id));
    calls.unshift(...open.map((block) => ({ name: block.name, input: block.input ?? {} })));
  }
  return calls;
}

// Codex: the calls since the turn started (`task_started`) with no output
// carrying their call_id. A `task_complete` after the last start means the
// turn is over and nothing is open.
export function codexPendingCalls(records) {
  const answered = new Set();
  const calls = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const { type } = records[i] ?? {};
    const payload = records[i]?.payload ?? {};
    if (type === "event_msg" && payload.type === "task_complete") {
      return [];
    }
    if (type === "event_msg" && payload.type === "task_started") {
      break;
    }
    if (type !== "response_item") {
      continue;
    }
    if (/_output$/.test(payload.type ?? "") && payload.call_id) {
      answered.add(payload.call_id);
    } else if ((payload.type === "function_call" || payload.type === "custom_tool_call") && !answered.has(payload.call_id)) {
      let input = {};
      if (payload.type === "function_call") {
        try {
          input = JSON.parse(payload.arguments);
        } catch {
          input = {};
        }
      } else {
        input = { text: String(payload.input ?? "") };
      }
      calls.unshift({ name: payload.name, input });
    }
  }
  return calls;
}

const SHOWN_LINES = 12;

function firstLines(text, count = SHOWN_LINES) {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  return lines.length <= count ? lines.join("\n") : `${lines.slice(0, count).join("\n")}\n… (${lines.length - count} more lines)`;
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0];
}

function prefixed(text, mark) {
  return firstLines(text)
    .split("\n")
    .map((line) => `${mark} ${line}`)
    .join("\n");
}

function heading(name, detail) {
  return detail ? `${name} · ${detail}` : name;
}

function commandText(value) {
  return Array.isArray(value) ? value.join(" ") : String(value ?? "");
}

// One open call as the person approving it should read it, each with the
// piece of it (`witness`) that must be on screen for the dialog to be about
// it. A call that asks several questions gives one candidate per question. A
// call with nothing worth showing gives none, and the screen is used instead —
// Codex's code-mode `exec` among them: its input is code that calls a shell,
// and the command being approved is somewhere inside it.
export function describeCall(agent, call) {
  const input = call?.input ?? {};
  const name = String(call?.name ?? "");
  if (agent === "claude") {
    switch (name) {
      case "Bash":
        return [{ text: `${heading("Bash", input.description)}\n${firstLines(input.command)}`, witness: firstLine(input.command) }];
      case "Edit":
        return [
          {
            text: `${heading("Edit", input.file_path)}\n${prefixed(input.old_string, "-")}\n${prefixed(input.new_string, "+")}`,
            witness: basename(String(input.file_path ?? "")),
          },
        ];
      case "MultiEdit":
        return [
          {
            text: [
              heading("Edit", input.file_path),
              ...(input.edits ?? []).map((edit) => `${prefixed(edit.old_string, "-")}\n${prefixed(edit.new_string, "+")}`),
            ].join("\n"),
            witness: basename(String(input.file_path ?? "")),
          },
        ];
      case "Write":
        return [{ text: `${heading("Write", input.file_path)}\n${firstLines(input.content)}`, witness: basename(String(input.file_path ?? "")) }];
      case "NotebookEdit":
        return [
          { text: `${heading("NotebookEdit", input.notebook_path)}\n${firstLines(input.new_source)}`, witness: basename(String(input.notebook_path ?? "")) },
        ];
      case "Read":
        return [{ text: heading("Read", input.file_path), witness: basename(String(input.file_path ?? "")) }];
      case "WebFetch": {
        let host = "";
        try {
          host = new URL(input.url).host;
        } catch {
          host = String(input.url ?? "");
        }
        return [{ text: [heading("WebFetch", input.url), input.prompt].filter(Boolean).join("\n"), witness: host }];
      }
      case "WebSearch":
        return [{ text: heading("WebSearch", input.query), witness: input.query }];
      case "AskUserQuestion":
        return (input.questions ?? []).map((question) => ({
          text: [
            question.question,
            "",
            ...(question.options ?? []).map(
              (option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
            ),
          ].join("\n"),
          witness: question.question,
          asks: true,
        }));
      case "ExitPlanMode":
        return [{ text: `Plan\n${firstLines(input.plan, 40)}`, witness: String(input.plan ?? "").split("\n").find((line) => line.trim()) }];
      default:
        // MCP and other tools: the name says what it is, the input what it does.
        return [
          {
            text: `${name}\n${firstLines(JSON.stringify(input, null, 2))}`,
            witness: name.split("__").at(-1),
          },
        ];
    }
  }
  if (agent === "codex") {
    if (["exec_command", "shell", "local_shell", "container.exec"].includes(name)) {
      const command = commandText(input.cmd ?? input.command);
      return [
        {
          text: [heading("Run", input.justification), firstLines(command), input.workdir ? `in ${input.workdir}` : ""]
            .filter(Boolean)
            .join("\n"),
          witness: firstLine(command),
        },
      ];
    }
    if (name === "apply_patch") {
      const patch = String(input.text ?? input.input ?? "");
      const file = patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1] ?? "";
      return [{ text: `Patch\n${firstLines(patch, 30)}`, witness: basename(file.trim()) }];
    }
    if (name === "request_user_input_async") {
      return (input.questions ?? []).map((question) => ({
        text: [question.title, "", ...(question.options ?? []).map((option, index) => `${index + 1}. ${option}`)].join("\n"),
        witness: question.title,
        asks: true,
      }));
    }
  }
  return [];
}

// Text compared with every space, line break and Markdown mark removed: the
// terminal wraps a long command wherever the width runs out, and renders
// headings and emphasis without their marks.
function squash(text) {
  return String(text ?? "")
    .replace(/[\s`*_#>…]+/g, "")
    .toLowerCase();
}

// The open call this screen's dialog is about, described, or undefined.
// A witness has to be long enough to mean something; only its start is
// compared, since the screen may cut a long line short.
export function pendingDialog(agent, records, screen) {
  const calls = agent === "claude" ? claudePendingCalls(records) : agent === "codex" ? codexPendingCalls(records) : [];
  const onScreen = squash(screen);
  for (const call of calls) {
    for (const candidate of describeCall(agent, call)) {
      const witness = squash(candidate.witness).slice(0, 40);
      if (witness.length >= 4 && onScreen.includes(witness)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// The body of a blocked ping from the pane's session: the call the dialog is
// about, then the question the dialog asks in words. Undefined when the
// session cannot be found or none of its open calls is the one on screen —
// the caller then reads the body off the screen as before.
export function sessionDialogBody(paneId, screen, { run = runHerdr, env = process.env } = {}) {
  const session = paneSession(paneId, { run, env });
  const path = sessionFile(session, env);
  if (!path) {
    return undefined;
  }
  const found = pendingDialog(session.agent, readSessionTail(path), screen);
  if (!found) {
    return undefined;
  }
  const question = found.asks ? "" : dialogQuestion(screen);
  return capAnswer(question ? `${found.text}\n\n${question}` : found.text);
}
