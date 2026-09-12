import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentDetectionSkipped,
  blockedDelayMs,
  blockedDelayStillMine,
  blockedSnippet,
  consecutiveGate,
  currentPaneStatus,
  decideBlockedReal,
  dialogChoices,
  dialogFingerprint,
  doneSnippet,
  formatMessage,
  formatWhere,
  loadDotEnv,
  markBlockedDelay,
  modeEnabled,
  optionKeyboard,
  paneIdFrom,
  panelAvailable,
  readJsonEnv,
  readPaneScreen,
  readScreenSettled,
  resolveStatus,
  resolveWorktree,
  screenHasLiveDialog,
  sendTelegram,
  shouldDebounce,
  shouldNotify,
  showPanel,
  sleep,
  stateDir,
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
// the previous detection pass. A pane that still reads blank after
// `readScreenSettled` is a redraw that never finished or a pane that is gone;
// it is skipped outright, and Herdr's status is never consulted for it.
//
// The exception is an agent whose lifecycle a hook owns (Herdr 0.9.0: Pi, OMP,
// Kimi Code, OpenCode, Kilo, MastraCode): there is no menu to find, so the
// integration's own `blocked` is the only witness there is.
let hookAuthoritative = false;
let detectionSkippedCache;

// One `agent get` per hook process: the panel polls this every 2s.
function detectionSkipped() {
  if (detectionSkippedCache === undefined) {
    detectionSkippedCache = { value: agentDetectionSkipped(paneId) };
  }
  return detectionSkippedCache.value;
}

function blockedIsReal(screen) {
  if (!String(screen).trim()) {
    // Nothing on the pane after several retries: a redraw that never finished,
    // or a pane that is gone. Either way there is no question to relay, and an
    // empty panel is exactly the bug this gate exists to prevent.
    return Boolean(decideBlockedReal({ screenReadable: false }));
  }
  const screenLive = screenHasLiveDialog(screen);
  const skipped = screenLive ? undefined : detectionSkipped();
  const verdict = decideBlockedReal({
    screenLive,
    detectionSkipped: skipped,
    stillBlocked: skipped === true ? stillBlocked(paneId) : false,
  });
  if (verdict === "hook-authoritative" && !hookAuthoritative) {
    console.log(`hook-authoritative · ${where}`);
  }
  // Tracks the latest verdict: if a menu does appear later, the ping gets its
  // buttons and its fingerprint back.
  hookAuthoritative = verdict === "hook-authoritative";
  return Boolean(verdict);
}

// A skip that explains itself: the log line carries the bottom of the screen,
// and the full capture lands on disk so an unrecognised dialog shape can become
// a test fixture instead of a silent drop.
function skipTrace(screen) {
  const lines = String(screen ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .map((line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line));
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "last-skipped-screen.txt"), String(screen ?? ""), "utf8");
  } catch {
    // A missing state dir must not turn a skip into a crash.
  }
  return `tail: ${lines.join(" | ") || "(empty screen)"}`;
}

// A blank pane and a pane whose dialog the parser did not recognise are two
// different failures, and only the second one is worth a fixture.
function blockedSkipReason(screen) {
  return String(screen ?? "").trim()
    ? "blocked but no dialog on screen"
    : "blocked but pane screen empty";
}

function deliverFromPanel(text, fingerprint) {
  const result = deliverReply(paneId, text, status, { fingerprint });
  if (herdrFailed(result)) {
    console.error(`panel delivery failed · ${where}: ${herdrErrorText(result)}`);
    return;
  }
  console.log(`panel sent · ${where}`);
}

// The pane moved on without us: the dialog is gone from the screen (answered
// in Herdr) or, for done, the agent was given new work. A hook-authoritative
// block has no dialog to watch, so its witness is the status instead.
const dialogGone = consecutiveGate(2);

function paneMovedOn() {
  if (status === "blocked") {
    if (hookAuthoritative) {
      const live = currentPaneStatus(paneId);
      return Boolean(live) && live !== "blocked";
    }
    const screen = readScreen();
    if (!String(screen).trim()) {
      // A pane mid-redraw reads back blank. That is not the dialog going away,
      // and closing the panel on it loses a question nobody answered.
      return false;
    }
    return dialogGone.observe(!blockedIsReal(screen));
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
async function runPanel({ options, body, timeoutMs, fingerprint }) {
  if (userAtPane(paneId)) {
    console.log(`panel skipped · ${where} · pane is on screen`);
    return "skipped";
  }
  console.log(`panel · ${title} · ${where}`);
  const result = await showPanel({ paneId, title, where, body, options, timeoutMs, until: panelShouldClose });
  if (result.kind === "button") {
    const option = options[result.index];
    deliverFromPanel(option?.send ?? String(result.index + 1), fingerprint);
    return "handled";
  }
  if (result.kind === "text") {
    deliverFromPanel(result.text, fingerprint);
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
  // A hook-authoritative block has no menu on screen: nothing to put on buttons
  // and nothing to fingerprint, so the reply comes back as free text.
  const dialogBacked = status === "blocked" && !hookAuthoritative;
  const options = dialogChoices(screen, { hookAuthoritative: !dialogBacked });
  const fingerprint = dialogBacked ? dialogFingerprint(screen) : undefined;
  const text = formatMessage(context, event, status, snippet);
  const messageId = await sendTelegram(token, chatId, text, {
    forceReply: status !== "blocked" || options.length === 0,
    replyMarkup: optionKeyboard(options),
  });
  rememberOutbound({ messageId, paneId, status, where, fingerprint, options });
}

if (status === "blocked") {
  // Herdr can fire while the pane is still redrawing, so settle the read first.
  const screen = await readScreenSettled(readScreen, { sleep });
  if (!blockedIsReal(screen)) {
    console.log(`skipped · ${where} · ${blockedSkipReason(screen)} · ${skipTrace(screen)}`);
    process.exit(0);
  }

  const delayMs = blockedDelayMs();
  // The panel gets the same gate as the Telegram ping: no menu on screen means
  // no buttons anywhere, only free text.
  const panelOptions = dialogChoices(screen, { hookAuthoritative });
  const fingerprint = hookAuthoritative ? undefined : dialogFingerprint(screen);
  if (usePanel && delayMs > 0) {
    // The panel replaces the blocked wait: answer on the desktop, or let it
    // time out and fall through to Telegram. If the user is (or arrives) at
    // the pane, the rest of the wait runs silently and Telegram still follows.
    if (shouldDebounce(paneId, "panel:blocked")) {
      process.exit(0);
    }
    const started = markBlockedDelay(paneId);
    const outcome = await runPanel({
      options: panelOptions,
      body: blockedSnippet(screen),
      timeoutMs: delayMs,
      fingerprint,
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
    const later = await readScreenSettled(readScreen, { sleep });
    if (!blockedDelayStillMine(paneId, started) || !blockedIsReal(later)) {
      process.exit(0);
    }
    await pingTelegram(later);
    process.exit(0);
  }

  if (delayMs > 0) {
    const started = markBlockedDelay(paneId);
    await sleep(delayMs);
    const later = await readScreenSettled(readScreen, { sleep });
    if (!blockedDelayStillMine(paneId, started) || !blockedIsReal(later)) {
      process.exit(0);
    }
    await pingTelegram(later);
  } else {
    await pingTelegram(screen);
  }
  if (usePanel && !shouldDebounce(paneId, "panel:blocked")) {
    await runPanel({
      options: panelOptions,
      body: blockedSnippet(screen),
      fingerprint,
    });
  }
  process.exit(0);
}

const screen = readScreen();
await pingTelegram(screen);
if (usePanel && isDone && !shouldDebounce(paneId, "panel:done")) {
  await runPanel({ options: [], body: doneSnippet(screen) });
}
