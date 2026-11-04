import {
  actionCommand,
  agentDetectionSkipped,
  blockedDelayMs,
  blockedDelayStillMine,
  blockedSnippet,
  blockedWaitVerdict,
  channelList,
  consecutiveGate,
  currentPaneStatus,
  decideBlockedReal,
  dialogChoices,
  dialogFingerprint,
  doneSnippet,
  ensureIntegrations,
  eventGate,
  formatMessage,
  formatWhere,
  integrationLines,
  loadDotEnv,
  markBlockedDelay,
  modeEnabled,
  nextDialog,
  paneAgentName,
  paneIdFrom,
  panelAvailable,
  pingChannels,
  readJsonEnv,
  readPaneScreen,
  readScreenSettled,
  remoteChannels,
  resolveStatus,
  resolveWorktree,
  saveScreen,
  screenHasLiveDialog,
  screenHasOpenMenu,
  sessionAnswer,
  sessionDialogBody,
  shouldDebounce,
  showPanel,
  sleep,
  statusTitle,
  stillBlocked,
  userAtPane,
} from "../lib/index.mjs";
import { deliverReply, herdrErrorText, herdrFailed, rememberOutbound } from "../inbound/reply.mjs";
import { describeError, ensurePoller } from "../inbound/poller.mjs";

// Every way this hook ends without a ping says so in the plugin log, for the
// statuses someone waits on. When a colleague's blocked pings stopped reaching
// Feishu while `test` still did, the log had nothing to offer: a hook that
// dropped the event, one that waited and found the dialog answered, and one
// that sent the ping all left the same empty line.
loadDotEnv();
ensurePoller();

const context = readJsonEnv("HERDR_PLUGIN_CONTEXT_JSON");
const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
const paneId = paneIdFrom(event, context);
const reported = resolveStatus(event, context);

if (!modeEnabled()) {
  const { reason } = eventGate(reported, { enabled: false });
  if (reason) {
    console.log(`off · ${reported} · ${paneId} · ${reason}; turn it back on: ${actionCommand("enable")}`);
  }
  process.exit(0);
}

// The paired channels CHANNEL selects; empty when none is paired.
const channels = remoteChannels();
const usePanel = panelAvailable();

if (!channels.length && !usePanel) {
  console.error("no remote channel paired (telegram or feishu) and no desktop panel");
  process.exit(0);
}

// Herdr misses some questions. Claude Code's multi-question form has been
// reported `done`, and then `idle`, with the form still up and waiting, and the
// done panel showed it as plain text with nothing to press. A `done` with an
// open menu on screen is a block, and the rest of this hook handles it as one.
// It is settled before the NOTIFY_ON filter, so a setup that only asks for
// questions still gets this one.
const promoted =
  (reported === "done" || reported === "finish") &&
  screenHasOpenMenu(await readScreenSettled(() => readPaneScreen(paneId), { sleep }));
const status = promoted ? "blocked" : reported;

const gate = eventGate(status);
if (!gate.go) {
  if (gate.reason) {
    console.log(`ignored · ${paneId} · ${gate.reason}`);
  }
  process.exit(0);
}

const worktree = resolveWorktree(context, event, paneId);
if (worktree) {
  context.worktree = worktree;
}
const where = formatWhere(context, event);
const title = statusTitle(context, event, status);
const isDone = status === "done" || status === "finish";
if (promoted) {
  console.log(`menu on screen · ${where} · herdr said ${reported}`);
}

// A form has a handful of tabs. The cap is only a backstop against a dialog
// that keeps changing shape without ever being satisfied.
const MAX_FORM_ANSWERS = 12;

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
  saveScreen("last-skipped-screen.txt", screen);
  return `tail: ${lines.join(" | ") || "(empty screen)"}`;
}

// A blank pane and a pane whose dialog the parser did not recognise are two
// different failures, and only the second one is worth a fixture.
function blockedSkipReason(screen) {
  return String(screen ?? "").trim()
    ? "blocked but no dialog on screen"
    : "blocked but pane screen empty";
}

// What a blocked dialog is about. The agent's session has the call verbatim —
// the whole command, not what fit on the screen — and is used when one of its
// open calls is the one on screen; otherwise the body is read off the screen.
// The choices, the keys and the fingerprint always come from the screen,
// since that is what a reply presses. One session read per distinct screen:
// the panel re-renders the same one while it follows a form.
let bodyMemo;
function blockedBody(screen) {
  if (bodyMemo?.screen !== screen) {
    const fromSession = sessionDialogBody(paneId, screen);
    bodyMemo = { screen, body: fromSession ?? blockedSnippet(screen), source: fromSession ? "session" : "screen" };
    if (!fromSession) {
      saveScreen("last-blocked-screen.txt", screen);
    }
    console.log(`blocked · ${where} · body from ${bodyMemo.source}`);
  }
  return bodyMemo.body;
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

// Returns "handled" | "resolved" | "at-pane" | "superseded" | "yielded" |
// "unavailable" | "timeout" | "dismiss" | "skipped".
async function runPanel({ options, body, timeoutMs, fingerprint }) {
  if (userAtPane(paneId)) {
    console.log(`panel skipped · ${where} · pane is on screen`);
    return "skipped";
  }
  console.log(`panel · ${title} · ${where}`);
  const result = await showPanel({
    paneId,
    title,
    where,
    body,
    options,
    timeoutMs,
    until: panelShouldClose,
    kind: status === "blocked" ? "blocked" : "report",
  });
  if (result.kind === "yielded") {
    console.log(`panel yielded · ${where} · a question is already on screen`);
    return "yielded";
  }
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

async function pingRemote(screen, doneBody) {
  if (!channels.length) {
    console.log(`not sent · ${where} · no paired phone channel in CHANNEL=${channelList().join(",")}`);
    return;
  }
  if (shouldDebounce(paneId, status)) {
    console.log(`debounced · ${where} · ${status} was pinged for this pane under DEBOUNCE_MS ago`);
    return;
  }
  const snippet = status === "blocked" ? blockedBody(screen) : isDone ? (doneBody ?? doneSnippet(screen)) : "";
  // A hook-authoritative block has no menu on screen: nothing to put on buttons
  // and nothing to fingerprint, so the reply comes back as free text.
  const dialogBacked = status === "blocked" && !hookAuthoritative;
  const options = dialogChoices(screen, { hookAuthoritative: !dialogBacked });
  const fingerprint = dialogBacked ? dialogFingerprint(screen) : undefined;
  const text = formatMessage(context, event, status, snippet);
  await pingChannels(channels, text, {
    status,
    options,
    where,
    describe: describeError,
    sent: (channel, messageId) =>
      rememberOutbound({ messageId, paneId, status, where, title, fingerprint, options, channel, text }),
  });
}

// After the wait: send, or say why not. A newer blocked event for the pane
// owns the ping now, and a dialog gone from the screen was answered.
async function pingAfterWait(started) {
  const later = await readScreenSettled(readScreen, { sleep });
  const stillMine = blockedDelayStillMine(paneId, started);
  const verdict = blockedWaitVerdict({ stillMine, screen: later, real: stillMine && blockedIsReal(later) });
  if (verdict) {
    console.log(`not sent · ${where} · ${verdict}`);
    return;
  }
  await pingRemote(later);
}

if (status === "blocked") {
  // Herdr can fire while the pane is still redrawing, so settle the read first.
  const screen = await readScreenSettled(readScreen, { sleep });
  if (!blockedIsReal(screen)) {
    console.log(`skipped · ${where} · ${blockedSkipReason(screen)} · ${skipTrace(screen)}`);
    process.exit(0);
  }

  const delayMs = blockedDelayMs();
  // The panel gets the same gate as the chat ping: no menu on screen means
  // no buttons anywhere, only free text.
  const panelOptions = dialogChoices(screen, { hookAuthoritative });
  const fingerprint = hookAuthoritative ? undefined : dialogFingerprint(screen);
  if (usePanel && delayMs > 0) {
    // The panel replaces the blocked wait: answer on the desktop, or let it
    // time out and fall through to the phone. If the user is (or arrives) at
    // the pane, the rest of the wait runs silently and the ping still follows.
    if (shouldDebounce(paneId, "panel:blocked")) {
      console.log(`debounced · ${where} · a blocked event for this pane is already being handled`);
      process.exit(0);
    }
    const started = markBlockedDelay(paneId);
    // A multi-question form answers one tab at a time and never leaves
    // `blocked`, so Herdr sends no second event: without following it here, the
    // panel would deliver one answer and vanish, leaving the rest of the form to
    // the terminal. Each answer is followed by whatever question replaces it.
    let live = { screen, options: panelOptions, fingerprint };
    let outcome;
    for (let answered = 0; ; answered++) {
      outcome = await runPanel({
        options: live.options,
        body: blockedBody(live.screen),
        timeoutMs: delayMs,
        fingerprint: live.fingerprint,
      });
      if (outcome !== "handled" || hookAuthoritative) {
        break;
      }
      if (answered + 1 >= MAX_FORM_ANSWERS) {
        console.log(`panel stopped following · ${where} · ${MAX_FORM_ANSWERS} answers`);
        process.exit(0);
      }
      const next = await nextDialog({
        read: () => readScreen(),
        status: () => currentPaneStatus(paneId),
        answered: live.fingerprint,
      });
      if (!next) {
        process.exit(0);
      }
      console.log(`panel follows on · ${where}`);
      live = {
        screen: next.screen,
        options: dialogChoices(next.screen, { hookAuthoritative: false }),
        fingerprint: next.fingerprint,
      };
    }
    if (outcome === "superseded") {
      console.log(`not sent · ${where} · a newer event for this pane took the panel over`);
    }
    if (outcome === "handled" || outcome === "superseded" || outcome === "resolved") {
      process.exit(0);
    }
    if (outcome === "unavailable" || outcome === "skipped" || outcome === "at-pane") {
      const remaining = delayMs - (Date.now() - started);
      if (remaining > 0) {
        await sleep(remaining);
      }
    }
    await pingAfterWait(started);
    process.exit(0);
  }

  if (delayMs > 0) {
    const started = markBlockedDelay(paneId);
    await sleep(delayMs);
    await pingAfterWait(started);
  } else {
    await pingRemote(screen);
  }
  if (usePanel && !shouldDebounce(paneId, "panel:blocked")) {
    await runPanel({
      options: panelOptions,
      body: blockedBody(screen),
      fingerprint,
    });
  }
  process.exit(0);
}

// A done ping carries the agent's last answer, taken from the agent's own
// session record when Herdr knows which session the pane runs (its Claude Code
// and Codex integrations report it). That record has the answer verbatim; the
// screen has it wrapped in whatever the agent draws around it, and reading it
// off there put a new agent footer into the ping every time one appeared.
//
// The screen stays the fallback. A `done` event lands the moment the turn
// ends, which is also when the agent is repainting the pane. The blank gate
// that settles `blocked` does not catch that here: the prompt box, the rules
// and the mode footer are drawn before the turn above them, so the read comes
// back non-blank and carries nothing worth sending. What makes a done read
// usable is having a turn in it, so that is what it waits for.
let screen = "";
let doneBody;
if (isDone) {
  doneBody = await sessionAnswer(paneId);
  let source = "session";
  if (!doneBody) {
    source = "screen";
    // A Codex pane with no session to find: usually Codex was installed after
    // Oncall, whose own startup and install already cover the rest. Herdr's
    // server can run for days without a restart, so the integration goes in
    // now. This session started without it and is read off the screen; the
    // next one reports its session.
    if (paneAgentName(paneId) === "codex") {
      for (const line of integrationLines(ensureIntegrations())) {
        console.log(line);
      }
    }
    screen = await readScreenSettled(readScreen, { sleep, ready: (text) => Boolean(doneSnippet(text)) });
    doneBody = doneSnippet(screen);
    saveScreen("last-done-screen.txt", screen);
  }
  console.log(`done · ${where} · answer from ${source}`);
} else {
  screen = readScreen();
}
await pingRemote(screen, doneBody);
if (usePanel && isDone && !shouldDebounce(paneId, "panel:done")) {
  await runPanel({ options: [], body: doneBody });
}
