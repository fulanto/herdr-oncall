import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockedSnippet,
  dialogChoices,
  dialogFingerprint,
  escalateAfterSec,
  escalationText,
  lookupAgentByName,
  modeEnabled,
  panelAvailable,
  panelFocus,
  pingChannels,
  readPaneScreen,
  remoteChannels,
  roleSettings,
  runHerdr,
  saveScreen,
  screenHasLiveDialog,
  sessionDialogBody,
  showPanel,
  sleep,
  stateDir,
  stuckFor,
} from "../lib/index.mjs";
import { deliverReply, herdrErrorText, herdrFailed, rememberOutbound } from "./reply.mjs";
import { describeError } from "./poller.mjs";

// An orchestrator's or a worker's dialog is approved by the layer above it, so
// the hook neither pings nor opens a panel for one. It writes down what is on
// screen and when it appeared, and the poller, the one process that is always
// running, looks again every half minute: the same dialog still waiting past
// the threshold means nobody above got to it, and only then does the user hear
// about it, once. A wait inside the hook would have meant one sleeping process
// per dialog for ten minutes, and the hook of an agent that is itself stuck is
// exactly the one that cannot be relied on to wake up.

export const ESCALATION_CHECK_MS = 30_000;

function storePath() {
  return join(stateDir(), "escalations.json");
}

export function readEscalations() {
  try {
    const store = JSON.parse(readFileSync(storePath(), "utf8"));
    return store && typeof store === "object" ? store : {};
  } catch {
    return {};
  }
}

function writeEscalations(store) {
  mkdirSync(dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store), "utf8");
}

// The hook's side. The same dialog seen again (Herdr fires `blocked` more than
// once for one) keeps its original start, so the clock is not reset by noise;
// a different dialog starts over. Returns { kept, record }.
export function armEscalation({ paneId, role, name, kind, where, fingerprint, thresholdSec }, now = Date.now()) {
  const store = readEscalations();
  const previous = store[paneId];
  if (previous && previous.fingerprint === fingerprint && previous.role === role) {
    store[paneId] = { ...previous, name, kind, where };
    writeEscalations(store);
    return { kept: true, record: store[paneId] };
  }
  const record = { paneId, role, name, kind, where, fingerprint, startedAt: now, armedThresholdSec: thresholdSec };
  store[paneId] = record;
  writeEscalations(store);
  return { kept: false, record };
}

// Applies one record's outcome to the file as it is now, not as it was read at
// the start of the pass: the hook can arm a newer dialog for the same pane
// while a ping is on its way, and a whole-store write would erase it. `change`
// is only applied while the record is still the one that was looked at.
function settle(paneId, seen, change) {
  const store = readEscalations();
  const current = store[paneId];
  if (!current || current.startedAt !== seen.startedAt || current.fingerprint !== seen.fingerprint) {
    return;
  }
  const next = change(current);
  if (next) {
    store[paneId] = next;
  } else {
    delete store[paneId];
  }
  writeEscalations(store);
}

function paneClosed(paneId, run) {
  const result = run(["pane", "get", paneId]);
  return herdrFailed(result) && /pane_not_found|not found/i.test(herdrErrorText(result));
}

// What the pane shows now, as far as this record is concerned:
// { kind: "live", screen, fingerprint } | { kind: "gone" } | { kind: "closed" }
// | { kind: "unreadable" }. A blank read is never evidence that the dialog
// went away (one read can land mid-redraw), and neither is one read without a
// dialog: it is read again a moment later before the record is dropped.
async function observe(record, { run, readScreen, wait, recheckMs }) {
  const first = readScreen(record.paneId);
  if (!String(first).trim()) {
    return paneClosed(record.paneId, run) ? { kind: "closed" } : { kind: "unreadable" };
  }
  if (screenHasLiveDialog(first)) {
    return { kind: "live", screen: first, fingerprint: dialogFingerprint(first) };
  }
  if (!record.fingerprint) {
    // An agent whose integration owns its state has no dialog to draw; its
    // status is the witness, as in the hook.
    const status = currentStatus(record.paneId, run);
    return status === "blocked" ? { kind: "live", screen: first, fingerprint: undefined } : { kind: "gone" };
  }
  await wait(recheckMs);
  const second = readScreen(record.paneId);
  if (!String(second).trim()) {
    return { kind: "unreadable" };
  }
  if (screenHasLiveDialog(second)) {
    return { kind: "live", screen: second, fingerprint: dialogFingerprint(second) };
  }
  return { kind: "gone" };
}

function currentStatus(paneId, run) {
  const result = run(["pane", "get", paneId]);
  if (herdrFailed(result)) {
    return undefined;
  }
  try {
    const payload = JSON.parse(result.stdout);
    const root = payload?.result?.pane ?? payload?.result ?? payload;
    const status = root?.agent_status ?? root?.agent?.state ?? root?.agent?.status;
    return typeof status === "string" ? status.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function label(record) {
  return `${record.role} · ${record.name} · ${record.where || record.paneId}`;
}

function titleFor(record) {
  const kind = String(record.kind || "agent");
  return `blocked · ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

// The dialog's body for the ping: the open call from the agent's session when
// one matches the screen, the screen otherwise, as for a blocked ping.
function dialogBody(record, screen, run) {
  const fromSession = sessionDialogBody(record.paneId, screen, { run });
  if (fromSession) {
    return fromSession;
  }
  saveScreen("last-blocked-screen.txt", screen);
  return blockedSnippet(screen);
}

// Default edges, for the poller. Tests pass their own.
function defaultPing({ record, text, options, fingerprint, channels }) {
  return pingChannels(channels, text, {
    status: "blocked",
    options,
    where: record.where || record.paneId,
    describe: describeError,
    sent: (channel, messageId) =>
      rememberOutbound({
        messageId,
        paneId: record.paneId,
        status: "blocked",
        where: record.where,
        title: titleFor(record),
        fingerprint,
        options,
        channel,
        text,
      }),
  });
}

// No phone paired: the desktop panel is the one way left to reach the user.
// It is not waited on by the pass, since it stays up for its whole timeout.
function defaultPanel({ record, text, options, fingerprint, run, readScreen }) {
  let gone = 0;
  showPanel({
    paneId: record.paneId,
    title: text.split("\n")[0],
    where: record.where || record.paneId,
    body: text.split("\n").slice(2).join("\n"),
    options,
    kind: "blocked",
    focus: panelFocus({ status: "blocked" }),
    until: () => {
      const screen = readScreen(record.paneId);
      if (!String(screen).trim()) {
        return false;
      }
      gone = screenHasLiveDialog(screen) && dialogFingerprint(screen) === fingerprint ? 0 : gone + 1;
      return gone >= 2 ? "moved-on" : false;
    },
  })
    .then((result) => {
      const typed = result.kind === "button" ? (options[result.index]?.send ?? String(result.index + 1)) : result.text;
      if (result.kind !== "button" && result.kind !== "text") {
        console.log(`escalation panel closed · ${label(record)} · ${result.reason || result.kind}`);
        return;
      }
      const delivered = deliverReply(record.paneId, typed, "blocked", { fingerprint, run });
      console.log(
        herdrFailed(delivered)
          ? `escalation panel delivery failed · ${label(record)}: ${herdrErrorText(delivered)}`
          : `escalation panel sent · ${label(record)}`,
      );
    })
    .catch((error) => console.error(`escalation panel failed · ${label(record)}: ${describeError(error)}`));
}

// One pass over every armed dialog. Every edge is a parameter so the whole
// decision runs in a test with a fake clock and a fake herdr.
export async function checkEscalations({
  now = Date.now(),
  run = runHerdr,
  readScreen = (paneId) => readPaneScreen(paneId, {}, run),
  settings = roleSettings(),
  enabled = modeEnabled(),
  channels = remoteChannels(),
  panelReady = panelAvailable(),
  mainKind,
  ping = defaultPing,
  panel = defaultPanel,
  body = (record, screen) => dialogBody(record, screen, run),
  wait = sleep,
  recheckMs = 1000,
  log = console.log,
} = {}) {
  const outcomes = [];
  let kindOfMain = mainKind;
  for (const [paneId, record] of Object.entries(readEscalations())) {
    const seen = await observe(record, { run, readScreen, wait, recheckMs });
    if (seen.kind === "unreadable") {
      outcomes.push({ paneId, outcome: "unreadable" });
      continue;
    }
    if (seen.kind === "closed" || seen.kind === "gone") {
      settle(paneId, record, () => undefined);
      log(`escalation cleared · ${label(record)} · ${seen.kind === "closed" ? "pane closed" : "dialog gone"}`);
      outcomes.push({ paneId, outcome: "cleared" });
      continue;
    }
    if (seen.fingerprint !== record.fingerprint) {
      settle(paneId, record, (current) => ({
        ...current,
        fingerprint: seen.fingerprint,
        startedAt: now,
        escalatedAt: undefined,
        heldAt: undefined,
      }));
      log(`escalation reset · ${label(record)} · a different dialog is up, counting from now`);
      outcomes.push({ paneId, outcome: "reset" });
      continue;
    }
    if (record.escalatedAt) {
      outcomes.push({ paneId, outcome: "already" });
      continue;
    }
    if (record.role === "supervisor" && kindOfMain === undefined) {
      kindOfMain = lookupAgentByName(settings.mainAgentName, run).kind ?? null;
    }
    const thresholdSec = escalateAfterSec({ role: record.role, mainKind: kindOfMain ?? undefined, settings });
    const elapsedMs = now - Number(record.startedAt);
    if (elapsedMs < thresholdSec * 1000) {
      outcomes.push({ paneId, outcome: "waiting" });
      continue;
    }
    if (!enabled) {
      if (!record.heldAt) {
        settle(paneId, record, (current) => ({ ...current, heldAt: now }));
        log(`escalation held · ${label(record)} · oncall is off`);
      }
      outcomes.push({ paneId, outcome: "held" });
      continue;
    }
    const text = escalationText({
      role: record.role,
      name: record.name,
      elapsedMs,
      where: record.where || record.paneId,
      body: body(record, seen.screen),
    });
    const options = dialogChoices(seen.screen, { hookAuthoritative: !record.fingerprint });
    // Marked before the send, so a slow or failed ping is still only tried once
    // per dialog: a second identical escalation is worse than none.
    settle(paneId, record, (current) => ({ ...current, escalatedAt: now }));
    if (channels.length) {
      log(`escalated · ${label(record)} · after ${stuckFor(elapsedMs)}`);
      await ping({ record, text, options, fingerprint: record.fingerprint, channels, run, readScreen });
      outcomes.push({ paneId, outcome: "pinged" });
    } else if (panelReady) {
      log(`escalated · ${label(record)} · after ${stuckFor(elapsedMs)} · desktop panel, no phone channel paired`);
      panel({ record, text, options, fingerprint: record.fingerprint, run, readScreen });
      outcomes.push({ paneId, outcome: "panel" });
    } else {
      log(`not sent · ${label(record)} · escalation due, but no paired phone channel and no panel`);
      outcomes.push({ paneId, outcome: "unsent" });
    }
  }
  return outcomes;
}

// The poller's loop around it.
export async function escalationLoop({ reload = () => {}, every = ESCALATION_CHECK_MS } = {}) {
  while (true) {
    try {
      reload();
      if (Object.keys(readEscalations()).length) {
        await checkEscalations();
      }
    } catch (error) {
      console.error(`escalation check failed · ${describeError(error)}`);
    }
    await sleep(every);
  }
}
