import { envFlag } from "./config.mjs";

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
