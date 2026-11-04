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

// The statuses someone is waiting to hear about. A dropped one of these says
// why in the plugin log; working and idle arrive on every turn and stay quiet.
function watched(status) {
  return status === "blocked" || status === "done" || status === "finish";
}

// Whether an event goes on to the notify hook's real work. Returns
// { go: true } or { go: false, reason }, where `reason` is what to log, empty
// for an event nobody is waiting on. Before this, an event dropped here left an
// empty line in the plugin log, and so did one dropped for any other reason.
export function eventGate(status, { enabled = true, notifyOn = process.env.NOTIFY_ON } = {}) {
  if (!enabled) {
    return { go: false, reason: watched(status) ? "oncall is off (toggled), nothing is sent" : "" };
  }
  if (!shouldNotify(status, notifyOn)) {
    const list = notifyStatuses(notifyOn).join(",");
    return { go: false, reason: watched(status) ? `${status} is not in NOTIFY_ON=${list}` : "" };
  }
  return { go: true };
}

// Why a blocked ping that sat out its wait (the panel, or BLOCKED_DELAY_SEC)
// is not sent after all, or undefined when it goes out. Each of these used to
// end the hook without a word, which is why a blocked ping that never reached
// the phone could not be told apart from one that was never meant to.
export function blockedWaitVerdict({ stillMine, screen, real }) {
  if (!stillMine) {
    return "a newer blocked event for this pane took over";
  }
  if (real) {
    return undefined;
  }
  return String(screen ?? "").trim()
    ? "the dialog left the screen during the wait (answered)"
    : "pane screen empty after the wait";
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
