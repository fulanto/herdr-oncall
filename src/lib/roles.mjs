import { BLOCKED_HINT } from "./format.mjs";
import { runHerdr } from "./paths.mjs";

// Who a pane is, as drover arranges it: the main session the user talks to,
// orchestrators it started (named with SUPERVISOR_PREFIX), and the workers they
// started (every other named agent). Each layer approves the dialogs of the one
// below it, so only the main session's dialogs are the user's to answer, and a
// dialog anywhere else reaches the user only when nobody above approved it for
// long enough. With MAIN_AGENT_NAME empty, which is what a machine without
// drover has, none of this applies and every pane is treated as in 0.6.6.

export const ROLE_DEFAULTS = {
  mainAgentName: "",
  supervisorPrefix: "orch-",
  supervisorEscalateSec: 300,
  supervisorEscalateSecCodex: 120,
  supervisedEscalateSec: 600,
  bareMessageTarget: "last",
};

function textSetting(env, key, fallback) {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function secondsSetting(env, key, fallback) {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// The effective settings, after loadDotEnv has merged the process environment,
// the .env files and drover.env. An empty value counts as unset.
export function roleSettings(env = process.env) {
  const target = textSetting(env, "BARE_MESSAGE_TARGET", ROLE_DEFAULTS.bareMessageTarget).toLowerCase();
  return {
    mainAgentName: textSetting(env, "MAIN_AGENT_NAME", ROLE_DEFAULTS.mainAgentName),
    supervisorPrefix: textSetting(env, "SUPERVISOR_PREFIX", ROLE_DEFAULTS.supervisorPrefix),
    supervisorEscalateSec: secondsSetting(env, "SUPERVISOR_ESCALATE_SEC", ROLE_DEFAULTS.supervisorEscalateSec),
    supervisorEscalateSecCodex: secondsSetting(
      env,
      "SUPERVISOR_ESCALATE_SEC_CODEX",
      ROLE_DEFAULTS.supervisorEscalateSecCodex,
    ),
    supervisedEscalateSec: secondsSetting(env, "SUPERVISED_ESCALATE_SEC", ROLE_DEFAULTS.supervisedEscalateSec),
    bareMessageTarget: target === "main" ? "main" : "last",
  };
}

export function rolesActive(settings = roleSettings()) {
  return Boolean(settings.mainAgentName);
}

// A bare chat message goes to the main session only when both are set.
export function bareToMain(settings = roleSettings()) {
  return rolesActive(settings) && settings.bareMessageTarget === "main";
}

// "main" | "supervisor" | "worker" | "user". "user" is a pane the user opened
// themselves (no name), and every pane while MAIN_AGENT_NAME is empty.
export function classifyRole(name, settings = roleSettings()) {
  const label = String(name ?? "").trim();
  if (!rolesActive(settings) || !label) {
    return "user";
  }
  if (label === settings.mainAgentName) {
    return "main";
  }
  if (settings.supervisorPrefix && label.startsWith(settings.supervisorPrefix)) {
    return "supervisor";
  }
  return "worker";
}

// Log lines name the role as it is ("worker", "supervisor"); a ping uses these.
export const ROLE_WORDS = { supervisor: "编排者", worker: "worker" };
const APPROVER_WORDS = { supervisor: "主会话", worker: "编排者" };

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

// The object `agent get` describes the agent with. Herdr's JSON shapes move
// between releases, so a few nestings are tried, as for the status.
function agentRecord(payload) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    if (root.agent && typeof root.agent === "object") {
      return root.agent;
    }
  }
  for (const root of roots) {
    if (typeof root.pane_id === "string" || typeof root.name === "string") {
      return root;
    }
  }
  return undefined;
}

function agentEntries(payload) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    for (const list of [root, root.agents, root.items, root.list]) {
      if (Array.isArray(list)) {
        return list.filter((item) => item && typeof item === "object");
      }
    }
  }
  return [];
}

// The agent's name in Herdr (`herdr agent rename`, `agent start <name>`), not
// its kind: `agent.agent` is "claude" or "codex", `agent.name` is the name, and
// a pane nobody named has no `name` at all.
export function extractAgentLabel(entry) {
  const value = entry?.name;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function describeEntry(entry) {
  if (!entry) {
    return undefined;
  }
  const kind = typeof entry.agent === "string" ? entry.agent : undefined;
  const status = typeof entry.agent_status === "string" ? entry.agent_status.toLowerCase() : undefined;
  return {
    name: extractAgentLabel(entry),
    kind,
    status,
    paneId: typeof entry.pane_id === "string" ? entry.pane_id : undefined,
  };
}

// { name, kind, status, paneId } for the agent in a pane, or undefined when
// Herdr could not say. `agent get` first, the list as a fallback.
export function paneAgentInfo(paneId, run = runHerdr) {
  if (!paneId) {
    return undefined;
  }
  const direct = describeEntry(agentRecord(herdrJson(["agent", "get", paneId], run)));
  if (direct) {
    return direct;
  }
  const entry = agentEntries(herdrJson(["agent", "list"], run)).find(
    (item) => String(item.pane_id ?? item.paneId ?? "") === String(paneId),
  );
  return describeEntry(entry);
}

// The notify hook's one question per event: { role, agent }. With
// MAIN_AGENT_NAME empty it asks Herdr nothing at all, so a machine without
// drover runs exactly the calls it ran before roles existed.
export function paneRole(paneId, { settings = roleSettings(), run = runHerdr } = {}) {
  if (!rolesActive(settings)) {
    return { role: "user", agent: undefined };
  }
  const agent = paneAgentInfo(paneId, run);
  return { role: classifyRole(agent?.name, settings), agent };
}

// The live agent with this name: { found: true, paneId, kind, status } or
// { found: false, error? }. Asked every time and never cached, since a name
// follows whoever occupies the pane and moves when the main session restarts.
export function lookupAgentByName(name, run = runHerdr) {
  if (!name) {
    return { found: false };
  }
  const result = run(["agent", "list"]);
  if (result?.error || result?.status !== 0 || !result?.stdout?.trim()) {
    return { found: false, error: String(result?.stderr || result?.error?.message || "herdr agent list failed").trim() };
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { found: false, error: "herdr agent list printed no JSON" };
  }
  const info = describeEntry(agentEntries(payload).find((item) => extractAgentLabel(item) === name));
  return info?.paneId ? { found: true, ...info } : { found: false };
}

// What the notify hook does with an event, by role. Pure, so every row of the
// table is a test:
//   "default"   as in 0.6.6 (panel, BLOCKED_DELAY_SEC, ping)
//   "api-error" the main session's turn ended on an API error: say so
//   "quiet"     somebody above handles it: no ping, no panel
//   "escalate"  no ping, no panel; the poller pings if nobody answers in time
export function notifyPlan({ role, status, apiError = false }) {
  const done = status === "done" || status === "finish";
  if (role === "supervisor" || role === "worker") {
    if (done) {
      return "quiet";
    }
    if (status === "blocked") {
      return "escalate";
    }
    return "default";
  }
  if (role === "main" && done && apiError) {
    return "api-error";
  }
  return "default";
}

// How long a dialog may sit before the user hears about it. An orchestrator
// under a Codex main session gets less: Codex has no Monitor to wake it, so
// nobody above is watching.
export function escalateAfterSec({ role, mainKind, settings = roleSettings() }) {
  if (role === "supervisor") {
    return mainKind === "codex" ? settings.supervisorEscalateSecCodex : settings.supervisorEscalateSec;
  }
  return settings.supervisedEscalateSec;
}

export function stuckFor(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分钟`;
}

// The escalation ping: who is stuck and for how long, where, who normally
// answers, then the dialog itself. Ends with BLOCKED_HINT like any blocked
// ping, which a Feishu card swaps for its own wording.
export function escalationText({ role, name, elapsedMs, where, body }) {
  return [
    `升级 · ${ROLE_WORDS[role] ?? role} ${name} 卡在确认框 ${stuckFor(elapsedMs)}`,
    where,
    `这类弹框平时由${APPROVER_WORDS[role] ?? "上一层"}批，它可能在忙或卡住了`,
    "",
    body || "waiting for input",
    "",
    BLOCKED_HINT,
  ].join("\n");
}

// A turn cut short by an API error, as drover's `api_error()` reads it
// (bin/drover, CLAUDE_API_ERROR_RE and the two after it). Claude Code prints
// "⏺ API Error: 503 …", sometimes under a tool call as "⎿  API Error: …"; Codex
// prints "■ stream error", "■ stream disconnected" or "■ unexpected status 502".
// Only an error line at the start of a line counts, and only when it is the
// last output block on screen: a report that mentions "API Error" in its text,
// or an earlier error followed by normal output, is not one.
const CLAUDE_API_ERROR_RE = /^\s*(?:[⏺⎿]\s*)?API Error\b/;
const CODEX_API_ERROR_RE = /^\s*■\s*(?:stream (?:error|disconnected)|unexpected status \d{3})/i;
const OUTPUT_BLOCK_RE = /^[⏺•]/;

export function apiErrorLine(screen) {
  const lines = String(screen ?? "")
    .replace(/\r/g, "")
    .split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (CLAUDE_API_ERROR_RE.test(line) || CODEX_API_ERROR_RE.test(line)) {
      return line.trim();
    }
    if (OUTPUT_BLOCK_RE.test(line)) {
      return undefined;
    }
  }
  return undefined;
}

export const API_ERROR_NOTICE = "主会话这一轮被接口错误打断了，回复「继续」让它接着做";

export function apiErrorMessage(line) {
  const detail = String(line ?? "").trim();
  return detail ? `${API_ERROR_NOTICE}\n\n${detail.slice(0, 200)}` : API_ERROR_NOTICE;
}
