import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ID = "com.codreamer.herdr.oncall";
export const OLD_PLUGIN_IDS = ["oncall", "oncall.telegram", "fulanto.oncall"];

export function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function runHerdr(args) {
  return spawnSync(herdrBin(), args, { encoding: "utf8" });
}

export function configDirPath() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  const result = runHerdr(["plugin", "config-dir", PLUGIN_ID]);
  const printed = !result.error && result.status === 0 ? result.stdout.trim() : "";
  if (printed) {
    return printed;
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".config") : pluginRoot);
  return join(configHome, "herdr", "plugins", "config", PLUGIN_ID);
}

export const DEFAULT_NOTIFY_ON = "blocked,done";

export function seedConfigEnv() {
  const dir = configDirPath();
  mkdirSync(dir, { recursive: true });
  const src = join(pluginRoot, ".env.example");
  copyFileSync(src, join(dir, ".env.example"));
  const dest = join(dir, ".env");
  if (!existsSync(dest)) {
    copyFileSync(src, dest);
  }
  upgradeEnvNotifyOn(dest);
  return dest;
}

function upgradeEnvNotifyOn(envPath) {
  const original = readFileSync(envPath, "utf8");
  let content = original;
  if (!/^NOTIFY_ON=/m.test(content)) {
    content = `${content.replace(/\s*$/, "")}\nNOTIFY_ON=${DEFAULT_NOTIFY_ON}\n`;
  } else {
    content = content.replace(/^NOTIFY_ON=\s*blocked\s*$/im, `NOTIFY_ON=${DEFAULT_NOTIFY_ON}`);
  }
  if (!/^BLOCKED_DELAY_SEC=/m.test(content)) {
    content = `${content.replace(/\s*$/, "")}\nBLOCKED_DELAY_SEC=60\n`;
  }
  if (content !== original) {
    writeFileSync(envPath, content, "utf8");
  }
}

export function loadDotEnv(path) {
  const paths = path ? [path] : defaultDotEnvPaths();
  for (const candidate of paths) {
    loadDotEnvFile(candidate);
  }
}

function defaultDotEnvPaths() {
  const paths = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    paths.push(join(process.env.HERDR_PLUGIN_CONFIG_DIR, ".env"));
  }
  paths.push(join(pluginRoot, ".env"));
  return [...new Set(paths)];
}

function loadDotEnvFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = stripQuotes(value);
  }
}

export function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  const stateHome =
    process.env.XDG_STATE_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".local", "state") : pluginRoot);
  return join(stateHome, "herdr-oncall");
}

export function modePath() {
  return join(stateDir(), "enabled");
}

export function modeEnabled() {
  const path = modePath();
  if (!existsSync(path)) {
    return envFlag("HERDR_TELEGRAM_ENABLED", true);
  }
  const raw = readFileSync(path, "utf8").trim().toLowerCase();
  return !["0", "false", "no", "off", "disabled"].includes(raw);
}

export function setMode(enabled) {
  const path = modePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, enabled ? "enabled\n" : "disabled\n", "utf8");
}

export function setWindowTitleIndicator(enabled) {
  if (!envFlag("HERDR_TELEGRAM_SET_TITLE", true)) {
    return;
  }
  const title = process.env.HERDR_TELEGRAM_TITLE || "oncall";
  const args = enabled
    ? ["terminal", "title", "set", title]
    : ["terminal", "title", "clear"];
  const bins = [...new Set([process.env.HERDR_BIN_PATH, "herdr"].filter(Boolean))];
  let lastError;
  for (const herdrBin of bins) {
    const result = spawnSync(herdrBin, args, { encoding: "utf8" });
    if (result.error) {
      lastError = result.error;
      continue;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      console.error(`title command exited ${result.status}${stderr ? `: ${stderr}` : ""}`);
      return;
    }
    return;
  }
  if (lastError) {
    console.error(`title command failed to start: ${lastError.message}`);
  }
}

export function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`invalid ${name}: ${error.message}`);
    return {};
  }
}

export function notifyStatuses(raw = process.env.NOTIFY_ON) {
  const text = String(raw ?? DEFAULT_NOTIFY_ON);
  const list = text
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_NOTIFY_ON.split(",");
}

export function statusFromEvent(event) {
  const status = event?.data?.agent_status;
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

export function statusFromContext(context) {
  const direct = context.focused_pane_status ?? context.agent_status ?? context.status;
  if (typeof direct === "string") {
    return direct.toLowerCase();
  }
  const eventStatus =
    context.event?.status ??
    context.event?.agent_status ??
    context.event?.pane?.agent_status ??
    context.event?.pane?.agent?.status;
  if (typeof eventStatus === "string") {
    return eventStatus.toLowerCase();
  }
  return undefined;
}

export function resolveStatus(event, context) {
  return statusFromEvent(event) ?? statusFromContext(context);
}

export function shouldNotify(status, rawNotifyOn) {
  if (!status) {
    return false;
  }
  return notifyStatuses(rawNotifyOn).includes(status);
}

export function paneIdFrom(event, context) {
  const raw =
    event?.data?.pane_id ??
    event?.pane_id ??
    context.pane_id ??
    context.focused_pane_id ??
    "";
  return String(raw);
}

export function shouldDebounce(paneId, status, now = Date.now()) {
  const windowMs = Number(process.env.DEBOUNCE_MS || 2000);
  if (!paneId || !status || !Number.isFinite(windowMs) || windowMs <= 0) {
    return false;
  }
  const path = join(stateDir(), "last-notify.json");
  let store = {};
  try {
    store = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    store = {};
  }
  const key = `${paneId}:${status}`;
  const previous = Number(store[key] ?? 0);
  if (previous && now - previous < windowMs) {
    return true;
  }
  store[key] = now;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), "utf8");
  return false;
}

export function blockedDelayMs(raw = process.env.BLOCKED_DELAY_SEC) {
  const sec = Number(raw ?? 60);
  if (!Number.isFinite(sec) || sec <= 0) {
    return 0;
  }
  return Math.round(sec * 1000);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayStorePath() {
  return join(stateDir(), "blocked-delay.json");
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function markBlockedDelay(paneId, now = Date.now()) {
  const path = delayStorePath();
  const store = readJsonFile(path);
  store[paneId] = now;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), "utf8");
  return now;
}

export function blockedDelayStillMine(paneId, startedAt) {
  const store = readJsonFile(delayStorePath());
  return Number(store[paneId] ?? 0) === Number(startedAt);
}

export function extractAgentStatus(payload) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    const candidates = [
      root.agent_status,
      root.agent?.state,
      root.agent?.status,
      root.pane?.agent_status,
      root.pane?.agent?.state,
      root.status,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim().toLowerCase();
      }
    }
  }
  return undefined;
}

export function currentPaneStatus(paneId) {
  if (!paneId) {
    return undefined;
  }
  const result = runHerdr(["pane", "get", paneId]);
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    return undefined;
  }
  try {
    return extractAgentStatus(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export function stillBlocked(paneId) {
  const status = currentPaneStatus(paneId);
  if (!status) {
    return true;
  }
  return status === "blocked";
}

export function formatMessage(context, event, status) {
  const agent = agentLabel(context, event);
  const line =
    status === "blocked" ? "waiting for input" : status === "done" ? "finished" : status;
  return [`${status} · ${agent}`, formatWhere(context, event), "", line].join("\n");
}

export function formatWhere(context = {}, event = {}) {
  const repo = repoName(context, event);
  const space = spaceName(context, event);
  const tab = namedTabLabel(context.tab_label ?? event?.data?.tab_label);
  const pane = paneOrdinal(paneIdFrom(event, context));
  const parts = [];
  if (repo) {
    parts.push(repo);
  }
  if (space && !equalsFold(space, repo)) {
    parts.push(space);
  }
  if (tab) {
    parts.push(tab);
  }
  if (pane) {
    parts.push(`pane ${pane}`);
  }
  return parts.join(" · ") || paneIdFrom(event, context) || "workspace";
}

function repoName(context, event) {
  const worktree = context.worktree ?? event?.data?.worktree ?? {};
  return firstString(
    worktree.repo_name,
    worktree.repoName,
    pathBasename(worktree.repo_root),
    pathBasename(worktree.checkout_path),
  );
}

function spaceName(context, event) {
  const id = firstString(context.workspace_id, event?.data?.workspace_id);
  const label = firstString(
    context.workspace_label,
    event?.data?.workspace_label,
    event?.data?.workspace_name,
  );
  if (label && label !== id && !isOpaqueWorkspaceId(label)) {
    return label;
  }
  const cwd = firstString(
    context.workspace_cwd,
    context.focused_pane_cwd,
    event?.data?.cwd,
    event?.data?.workspace_cwd,
  );
  const fromCwd = pathBasename(cwd);
  if (fromCwd && fromCwd !== id && !isOpaqueWorkspaceId(fromCwd)) {
    return fromCwd;
  }
  if (label && !isOpaqueWorkspaceId(label)) {
    return label;
  }
  return undefined;
}

function paneOrdinal(paneId) {
  const match = String(paneId).match(/:p([0-9A-Za-z]+)$/i);
  return match ? match[1] : undefined;
}

function isOpaqueWorkspaceId(text) {
  return /^w[0-9A-Za-z]{1,3}$/.test(String(text));
}

function pathBasename(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const name = basename(value.trim().replace(/[\\/]+$/, ""));
  return name && name !== "." && name !== ".git" ? name : undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function equalsFold(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function agentLabel(context, event) {
  const raw =
    event?.data?.display_agent ??
    event?.data?.agent ??
    context.focused_pane_agent ??
    context.agent ??
    "agent";
  return titleCase(raw);
}

function namedTabLabel(label) {
  const text = String(label ?? "").trim();
  if (!text || /^\d+$/.test(text)) {
    return undefined;
  }
  return text;
}

function titleCase(value) {
  const text = String(value).trim();
  if (!text) {
    return "Agent";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export async function sendTelegram(token, chatId, text, options = {}) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  const forceReply = options.forceReply ?? envFlag("TELEGRAM_FORCE_REPLY", true);
  if (forceReply) {
    payload.reply_markup = { force_reply: true, selective: true };
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`telegram sendMessage failed: ${response.status} ${body}`);
  }
  try {
    const json = JSON.parse(body);
    return json?.result?.message_id;
  } catch {
    return undefined;
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
