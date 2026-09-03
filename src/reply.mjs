import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  currentPaneStatus,
  envFlag,
  runHerdr,
  sendTelegram,
  stateDir,
} from "./lib.mjs";

const OUTBOUND_TTL_MS = 24 * 60 * 60 * 1000;
const NAMED_KEYS = {
  enter: "enter",
  esc: "esc",
  escape: "esc",
  tab: "tab",
  space: "space",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

export function namedReplyKey(text) {
  const key = String(text || "")
    .trim()
    .toLowerCase();
  if (NAMED_KEYS[key]) {
    return NAMED_KEYS[key];
  }
  if (/^[a-z0-9]$/.test(key)) {
    return key;
  }
  return undefined;
}

export function classifyDelivery(liveStatus, text) {
  const status = String(liveStatus || "").toLowerCase();
  const key = namedReplyKey(text);
  if (status === "blocked") {
    if (key) {
      return { mode: "keys", keys: [key] };
    }
    return { mode: "text-enter" };
  }
  return { mode: "prompt" };
}

function outboundPath() {
  return join(stateDir(), "outbound.json");
}

function offsetPath() {
  return join(stateDir(), "telegram-offset");
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

export function pruneOutbound(store, now = Date.now()) {
  const next = {};
  for (const [id, record] of Object.entries(store || {})) {
    if (record?.paneId && Number(record.at) && now - Number(record.at) < OUTBOUND_TTL_MS) {
      next[id] = record;
    }
  }
  return next;
}

export function rememberOutbound(record, now = Date.now()) {
  if (!record?.messageId || !record?.paneId) {
    return;
  }
  const path = outboundPath();
  const store = pruneOutbound(readJson(path, {}), now);
  store[String(record.messageId)] = {
    paneId: record.paneId,
    status: record.status,
    where: record.where,
    at: now,
  };
  writeJson(path, store);
}

export function lookupOutbound(messageId, now = Date.now()) {
  if (messageId === undefined || messageId === null) {
    return undefined;
  }
  const store = pruneOutbound(readJson(outboundPath(), {}), now);
  return store[String(messageId)];
}

export function lastOutbound(now = Date.now()) {
  const store = pruneOutbound(readJson(outboundPath(), {}), now);
  let latest;
  for (const record of Object.values(store)) {
    if (!latest || Number(record.at) > Number(latest.at)) {
      latest = record;
    }
  }
  return latest;
}

export function resolveReplyTarget(message, now = Date.now()) {
  const replyId = message?.reply_to_message?.message_id;
  const hit = lookupOutbound(replyId, now);
  if (hit) {
    return hit;
  }
  return lastOutbound(now);
}

export function readOffset() {
  try {
    const raw = readFileSync(offsetPath(), "utf8").trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeOffset(value) {
  mkdirSync(dirname(offsetPath()), { recursive: true });
  writeFileSync(offsetPath(), `${value}\n`, "utf8");
}

export function herdrFailed(result) {
  return Boolean(result?.error) || result?.status !== 0;
}

export function herdrErrorText(result) {
  return (
    result?.stderr?.trim() ||
    result?.stdout?.trim() ||
    result?.error?.message ||
    "herdr failed"
  );
}

export function isAgentBlockedError(result) {
  return `${result?.stderr || ""} ${result?.stdout || ""}`.toLowerCase().includes("agent_blocked");
}

export function deliverReply(paneId, text, fallbackStatus) {
  const live = currentPaneStatus(paneId);
  const status = live || fallbackStatus || "unknown";
  const plan = classifyDelivery(status, text);
  if (plan.mode === "keys") {
    return runHerdr(["pane", "send-keys", paneId, ...plan.keys]);
  }
  if (plan.mode === "text-enter") {
    const typed = runHerdr(["pane", "send-text", paneId, text]);
    if (herdrFailed(typed)) {
      return typed;
    }
    return runHerdr(["pane", "send-keys", paneId, "enter"]);
  }
  const prompted = runHerdr(["agent", "prompt", paneId, text]);
  if (isAgentBlockedError(prompted)) {
    const typed = runHerdr(["pane", "send-text", paneId, text]);
    if (herdrFailed(typed)) {
      return typed;
    }
    return runHerdr(["pane", "send-keys", paneId, "enter"]);
  }
  return prompted;
}

export async function telegramGetUpdates(token, offset) {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  if (offset) {
    url.searchParams.set("offset", String(offset));
  }
  url.searchParams.set("timeout", "25");
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
  const response = await fetch(url, { signal: AbortSignal.timeout(35_000) });
  const json = await response.json();
  if (!json.ok) {
    throw new Error(json.description || "telegram getUpdates failed");
  }
  return json.result || [];
}

export async function handleTelegramUpdate(update, { token, chatId }) {
  if (update?.callback_query) {
    return handleCallback(update.callback_query, { token, chatId });
  }
  const message = update?.message;
  if (!message?.text) {
    return { skipped: "no-text" };
  }
  if (String(message.chat?.id) !== String(chatId)) {
    return { skipped: "chat" };
  }
  const text = message.text.trim();
  if (!text || text.startsWith("/")) {
    if (text === "/start" || text === "/help") {
      await sendTelegram(
        token,
        chatId,
        "Blocked: tap a choice or type one. Done: send a new instruction.",
        { forceReply: false },
      );
    }
    return { skipped: "command" };
  }
  const target = resolveReplyTarget(message);
  if (!target?.paneId) {
    await sendTelegram(token, chatId, "Reply to a ping so I know which pane.", { forceReply: false });
    return { skipped: "no-target" };
  }
  return finishDelivery(target, text, { token, chatId });
}

async function handleCallback(query, { token, chatId }) {
  const chat = query?.message?.chat?.id ?? query?.from?.id;
  if (chat !== undefined && String(chat) !== String(chatId) && String(query?.from?.id) !== String(chatId)) {
    console.log(`callback chat mismatch got=${chat} want=${chatId}`);
    return { skipped: "chat" };
  }
  const text = String(query?.data || "").trim();
  if (!text) {
    return { skipped: "no-data" };
  }
  const target = lookupOutbound(query?.message?.message_id) || lastOutbound();
  console.log(`callback data=${text} pane=${target?.paneId || "none"}`);
  await answerCallbackQuery(token, query.id, target?.paneId ? "sending" : "no pane");
  if (!target?.paneId) {
    await sendTelegram(token, chatId, "no pane mapped for that button", { forceReply: false });
    return { skipped: "no-target" };
  }
  return finishDelivery(target, text, { token, chatId });
}

async function finishDelivery(target, text, { token, chatId }) {
  const result = deliverReply(target.paneId, text, target.status);
  const ok = !herdrFailed(result);
  const ack = ok
    ? `sent · ${target.where || target.paneId}`
    : `failed · ${target.where || target.paneId}\n${herdrErrorText(result)}`;
  await sendTelegram(token, chatId, ack, { forceReply: false });
  return { ok, paneId: target.paneId, mode: classifyDelivery(target.status, text).mode };
}

async function answerCallbackQuery(token, id, text) {
  if (!id) {
    return;
  }
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text, show_alert: false }),
  }).catch(() => {});
}

export function pollEnabled() {
  return envFlag("TELEGRAM_POLL", true);
}
