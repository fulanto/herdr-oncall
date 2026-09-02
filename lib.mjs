import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
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

export function seedConfigEnv() {
  const dir = configDirPath();
  mkdirSync(dir, { recursive: true });
  const src = join(pluginRoot, ".env.example");
  copyFileSync(src, join(dir, ".env.example"));
  const dest = join(dir, ".env");
  if (!existsSync(dest)) {
    copyFileSync(src, dest);
  }
  return dest;
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
  const text = String(raw ?? "blocked");
  const list = text
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : ["blocked"];
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

export function formatMessage(context, event, status) {
  const agent = agentLabel(context, event);
  const workspace =
    context.workspace_label ?? event?.data?.workspace_id ?? context.workspace_id ?? "workspace";
  const pane = paneIdFrom(event, context);
  const tab = namedTabLabel(context.tab_label);
  const where = [workspace, tab, pane].filter(Boolean).join(" · ");
  const line = status === "blocked" ? "waiting for input" : status;
  return [`${status} · ${agent}`, where, "", line].join("\n");
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

export async function sendTelegram(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`telegram sendMessage failed: ${response.status} ${body}`);
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
