import {
  blockedDelayMs,
  blockedDelayStillMine,
  blockedSnippet,
  formatMessage,
  formatWhere,
  loadDotEnv,
  markBlockedDelay,
  modeEnabled,
  optionKeyboard,
  paneIdFrom,
  parseBlockedOptions,
  readJsonEnv,
  readPaneScreen,
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

const screen = status === "blocked" ? readPaneScreen(paneId) : "";
const snippet = status === "blocked" ? blockedSnippet(screen) : "";
const options = status === "blocked" ? parseBlockedOptions(screen) : [];
const text = formatMessage(context, event, status, snippet);
const messageId = await sendTelegram(token, chatId, text, {
  forceReply: status !== "blocked" || options.length === 0,
  replyMarkup: optionKeyboard(options),
});
rememberOutbound({
  messageId,
  paneId,
  status,
  where: formatWhere(context, event),
});
