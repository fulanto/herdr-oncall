import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_NOTIFY_ON } from "./config.mjs";
import { stateDir } from "./paths.mjs";

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
