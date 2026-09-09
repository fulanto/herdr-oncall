import {
  blockedDelayMs,
  blockedDelayStillMine,
  blockedSnippet,
  currentPaneStatus,
  doneSnippet,
  formatMessage,
  formatWhere,
  loadDotEnv,
  markBlockedDelay,
  modeEnabled,
  optionKeyboard,
  paneIdFrom,
  panelAvailable,
  parseBlockedOptions,
  readJsonEnv,
  readPaneScreen,
  resolveStatus,
  resolveWorktree,
  screenHasLiveDialog,
  sendTelegram,
  shouldDebounce,
  shouldNotify,
  showPanel,
  sleep,
  statusTitle,
  stillBlocked,
  userAtPane,
} from "../lib/index.mjs";
import { deliverReply, herdrErrorText, herdrFailed, rememberOutbound } from "../inbound/reply.mjs";
import { ensurePoller } from "../inbound/poller.mjs";

loadDotEnv();
ensurePoller();
if (!modeEnabled()) {
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
const telegramReady = Boolean(token && chatId);
const usePanel = panelAvailable();

if (!telegramReady && !usePanel) {
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
const worktree = resolveWorktree(context, event, paneId);
if (worktree) {
  context.worktree = worktree;
}
const where = formatWhere(context, event);
const title = statusTitle(context, event, status);
const isDone = status === "done" || status === "finish";

function readScreen() {
  if (status === "blocked") {
    return readPaneScreen(paneId);
  }
  if (isDone) {
    return readPaneScreen(paneId, { recent: true });
  }
  return "";
}

// The screen is the source of truth for `blocked`. Herdr reports the status
// from its own text matching, which fires on dialog wording anywhere in the
// recent buffer — an agent that merely printed a permission prompt pins the
// pane at blocked — and the value it hands back can also be a stale one from
// the previous detection pass. Only fall back to it when the pane cannot be
// read at all.
function blockedIsReal(screen) {
  if (!String(screen).trim()) {
    return stillBlocked(paneId);
  }
  return screenHasLiveDialog(screen);
}

function deliverFromPanel(text) {
  const result = deliverReply(paneId, text, status);
  if (herdrFailed(result)) {
    console.error(`panel delivery failed · ${where}: ${herdrErrorText(result)}`);
    return;
  }
  console.log(`panel sent · ${where}`);
}

// The pane moved on without us: the dialog is gone from the screen (answered
// in Herdr) or, for done, the agent was given new work.
function paneMovedOn() {
  if (status === "blocked") {
    return !blockedIsReal(readScreen());
  }
  const live = currentPaneStatus(paneId);
  if (!live) {
    return false;
  }
  return live === "working" || live === "blocked";
}

// Reasons to close an open panel, polled while it is up.
function panelShouldClose() {
  if (paneMovedOn()) {
    return "moved-on";
  }
  if (userAtPane(paneId)) {
    return "at-pane";
  }
  return false;
}

// Returns "handled" | "resolved" | "at-pane" | "superseded" | "unavailable" |
// "timeout" | "dismiss" | "skipped".
async function runPanel({ options, body, timeoutMs }) {
  if (userAtPane(paneId)) {
    console.log(`panel skipped · ${where} · pane is on screen`);
    return "skipped";
  }
  console.log(`panel · ${title} · ${where}`);
  const result = await showPanel({ paneId, title, where, body, options, timeoutMs, until: panelShouldClose });
  if (result.kind === "button") {
    const option = options[result.index];
    deliverFromPanel(option?.send ?? String(result.index + 1));
    return "handled";
  }
  if (result.kind === "text") {
    deliverFromPanel(result.text);
    return "handled";
  }
  if (result.kind === "resolved") {
    console.log(`panel closed · ${where} · ${result.reason}`);
    return result.reason === "at-pane" ? "at-pane" : "resolved";
  }
  return result.kind;
}

async function pingTelegram(screen) {
  if (!telegramReady || shouldDebounce(paneId, status)) {
    return;
  }
  const snippet = status === "blocked" ? blockedSnippet(screen) : isDone ? doneSnippet(screen) : "";
  const options = status === "blocked" ? parseBlockedOptions(screen) : [];
  const text = formatMessage(context, event, status, snippet);
  const messageId = await sendTelegram(token, chatId, text, {
    forceReply: status !== "blocked" || options.length === 0,
    replyMarkup: optionKeyboard(options),
  });
  rememberOutbound({ messageId, paneId, status, where });
}

if (status === "blocked") {
  const screen = readScreen();
  if (!blockedIsReal(screen)) {
    console.log(`skipped · ${where} · blocked but no dialog on screen`);
    process.exit(0);
  }

  const delayMs = blockedDelayMs();
  if (usePanel && delayMs > 0) {
    // The panel replaces the blocked wait: answer on the desktop, or let it
    // time out and fall through to Telegram. If the user is (or arrives) at
    // the pane, the rest of the wait runs silently and Telegram still follows.
    if (shouldDebounce(paneId, "panel:blocked")) {
      process.exit(0);
    }
    const started = markBlockedDelay(paneId);
    const outcome = await runPanel({
      options: parseBlockedOptions(screen),
      body: blockedSnippet(screen),
      timeoutMs: delayMs,
    });
    if (outcome === "handled" || outcome === "superseded" || outcome === "resolved") {
      process.exit(0);
    }
    if (outcome === "unavailable" || outcome === "skipped" || outcome === "at-pane") {
      const remaining = delayMs - (Date.now() - started);
      if (remaining > 0) {
        await sleep(remaining);
      }
    }
    const later = readScreen();
    if (!blockedDelayStillMine(paneId, started) || !blockedIsReal(later)) {
      process.exit(0);
    }
    await pingTelegram(later);
    process.exit(0);
  }

  if (delayMs > 0) {
    const started = markBlockedDelay(paneId);
    await sleep(delayMs);
    const later = readScreen();
    if (!blockedDelayStillMine(paneId, started) || !blockedIsReal(later)) {
      process.exit(0);
    }
    await pingTelegram(later);
  } else {
    await pingTelegram(screen);
  }
  if (usePanel && !shouldDebounce(paneId, "panel:blocked")) {
    await runPanel({ options: parseBlockedOptions(screen), body: blockedSnippet(screen) });
  }
  process.exit(0);
}

const screen = readScreen();
await pingTelegram(screen);
if (usePanel && isDone && !shouldDebounce(paneId, "panel:done")) {
  await runPanel({ options: [], body: doneSnippet(screen) });
}
