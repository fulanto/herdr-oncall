import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envFlag } from "./config.mjs";
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
