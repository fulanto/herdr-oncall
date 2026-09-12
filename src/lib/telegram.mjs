import { envFlag } from "./config.mjs";

const TELEGRAM_API = "https://api.telegram.org";

// One door for every Telegram call, so the timeout and the tolerant body parse
// are decided in a single place.
export async function telegramApi(token, method, payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const hasPayload = payload !== undefined && payload !== null;
  const httpMethod = hasPayload ? "POST" : "GET";
  const headers = hasPayload ? { "content-type": "application/json" } : {};
  const body = hasPayload ? JSON.stringify(payload) : undefined;

  const response = await fetch(url, {
    method: httpMethod,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, text, json: parseBody(text) };
}

// Telegram answers a rate limit or an outage with HTML, not JSON; the callers
// below all branch on `ok`/`status`, so a bad body must never throw here.
function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function telegramGetMe(token) {
  const { json } = await telegramApi(token, "getMe", undefined, { timeoutMs: 15_000 });
  if (!json?.ok) {
    throw new Error(json?.description || "telegram getMe failed");
  }
  return json.result;
}

export async function sendTelegram(token, chatId, text, options = {}) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  const forceReply = options.forceReply ?? envFlag("TELEGRAM_FORCE_REPLY", true);
  if (options.replyMarkup) {
    payload.reply_markup = options.replyMarkup;
  } else if (forceReply) {
    payload.reply_markup = { force_reply: true, selective: true };
  }
  const { ok, status, text: body, json } = await telegramApi(token, "sendMessage", payload);
  if (!ok) {
    throw new Error(`telegram sendMessage failed: ${status} ${body}`);
  }
  return json?.result?.message_id;
}

export async function telegramGetUpdates(token, offset) {
  const payload = {
    timeout: 25,
    allowed_updates: ["message", "callback_query"],
  };
  if (offset) {
    payload.offset = Number(offset);
  }
  // The server holds the request for `timeout` seconds; the client budget must outlast it.
  const { json } = await telegramApi(token, "getUpdates", payload, { timeoutMs: 35_000 });
  if (!json?.ok) {
    throw new Error(json?.description || "telegram getUpdates failed");
  }
  return json.result || [];
}

export async function telegramAnswerCallback(token, callbackQueryId, text) {
  if (!callbackQueryId) {
    return;
  }
  // A missed ack only leaves the button spinner up; never fail a delivery over it.
  await telegramApi(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  }).catch(() => {});
}
