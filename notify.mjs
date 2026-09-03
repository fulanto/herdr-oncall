import {
  blockedDelayMs,
  blockedDelayStillMine,
  formatMessage,
  formatWhere,
  loadDotEnv,
  markBlockedDelay,
  modeEnabled,
  paneIdFrom,
  readJsonEnv,
  resolveStatus,
  sendTelegram,
  shouldDebounce,
  shouldNotify,
  sleep,
  stillBlocked,
} from "./lib.mjs";
import { rememberOutbound } from "./reply.mjs";

loadDotEnv();
if (!modeEnabled()) {
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

if (!token || !chatId) {
  console.error("missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(0);
}

const context = readJsonEnv("HERDR_PLUGIN_CONTEXT_JSON");
const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
const status = resolveStatus(event, context);

if (!shouldNotify(status)) {
  process.exit(0);
}

const paneId = paneIdFrom(event, context);

if (status === "blocked") {
  const delayMs = blockedDelayMs();
  if (delayMs > 0) {
    const started = markBlockedDelay(paneId);
    await sleep(delayMs);
    if (!blockedDelayStillMine(paneId, started)) {
      process.exit(0);
    }
    if (!stillBlocked(paneId)) {
      process.exit(0);
    }
  }
}

if (shouldDebounce(paneId, status)) {
  process.exit(0);
}

const text = formatMessage(context, event, status);
const messageId = await sendTelegram(token, chatId, text);
rememberOutbound({
  messageId,
  paneId,
  status,
  where: formatWhere(context, event),
});
