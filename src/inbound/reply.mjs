import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockedSnippet,
  callState,
  composeMessage,
  consumePairCode,
  currentPaneStatus,
  dialogChoices,
  dialogFingerprint,
  envFlag,
  extractStartPayload,
  mainBlockedText,
  modeEnabled,
  nextDialog,
  openPanelFor,
  optionKeyboard,
  pendingPair,
  readPaneScreen,
  roleSettings,
  rolesActive,
  runHerdr,
  saveScreen,
  screenHasLiveDialog,
  screenHasOpenMenu,
  sendTelegram,
  sessionDialog,
  sessionDialogBody,
  stateDir,
  statusTitle,
  telegramAnswerCallback,
  upsertEnvValue,
} from "../lib/index.mjs";
import { describeError } from "./poller.mjs";
import { OFF_NOTICE, routeChatMessage } from "./main-inbox.mjs";

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
    // The ping's own heading ("blocked · Claude"), so the next question of a
    // form can go out under the same one without the hook's event.
    title: record.title,
    // What the pane was asking when this ping went out, so a late tap can be
    // checked against the dialog it was meant for.
    fingerprint: record.fingerprint,
    options: record.options,
    channel: record.channel,
    // Only a Feishu card is ever rebuilt after it was sent, to swap its buttons
    // for what was pressed; nothing else needs the text kept around.
    text: record.channel === "feishu" && record.options?.length ? record.text : undefined,
    // "main": the main session's ping with drover, which carries no title or
    // location line; a form's next question goes out the same way.
    layout: record.layout,
    // The tool call the dialog was about, as the session records it
    // ({ agent, file, id, asks, ... }), when one could be matched: what tells
    // a redrawn dialog from a different one (staleDialog).
    call: record.call,
    at: now,
  };
  writeJson(path, store);
}

// A card that can no longer be used: tapped, refused as stale, or replaced by
// a newer card for the dialog now on screen. Only a card still in use keeps
// the hook from sending another one for the same call.
export function markOutbound(messageId, patch, now = Date.now()) {
  const path = outboundPath();
  const store = pruneOutbound(readJson(path, {}), now);
  const key = String(messageId);
  if (store[key]) {
    store[key] = { ...store[key], ...patch };
    writeJson(path, store);
  }
}

// A card already out for this very call that can still be pressed: same pane,
// same call, not spent, and the call still waiting for its answer.
export function usableCardFor(paneId, callId, { now = Date.now(), state = callState } = {}) {
  if (!paneId || !callId) {
    return undefined;
  }
  const store = pruneOutbound(readJson(outboundPath(), {}), now);
  for (const [messageId, record] of Object.entries(store)) {
    if (record.paneId === paneId && record.status === "blocked" && !record.spent && record.call?.id === callId && state(record.call) === "open") {
      return { messageId, ...record };
    }
  }
  return undefined;
}

// What is already in front of the user for the call this dialog is about:
// "panel" (a panel for it is open), "card" (a card for it can still be
// pressed), or undefined, when a new one is due. Herdr can report `blocked`
// again for a dialog that never went away; only a dialog with a call to go by
// can be recognised, and a form never is (its call stays the same while its
// questions change).
export function alreadyShown(paneId, call, { state = callState, openPanel = openPanelFor, now = Date.now() } = {}) {
  if (!call?.id || call.asks) {
    return undefined;
  }
  if (openPanel(paneId)?.callId === call.id) {
    return "panel";
  }
  return usableCardFor(paneId, call.id, { state, now }) ? "card" : undefined;
}

export function lookupOutbound(messageId, now = Date.now()) {
  if (messageId === undefined || messageId === null) {
    return undefined;
  }
  const store = pruneOutbound(readJson(outboundPath(), {}), now);
  const hit = store[String(messageId)];
  return hit ? { ...hit, messageId: String(messageId) } : undefined;
}

export function lastOutbound(now = Date.now()) {
  const store = pruneOutbound(readJson(outboundPath(), {}), now);
  let latest;
  for (const [messageId, record] of Object.entries(store)) {
    if (!latest || Number(record.at) > Number(latest.at)) {
      latest = { ...record, messageId };
    }
  }
  return latest;
}

export function resolveReplyTarget(message, now = Date.now()) {
  return replyTarget(message?.reply_to_message?.message_id, now);
}

// `quotedId` is the ping a reply quoted, if it quoted one: Telegram's
// reply_to_message, Feishu's parent_id.
export function replyTarget(quotedId, now = Date.now()) {
  const hit = lookupOutbound(quotedId, now);
  if (hit) {
    // This reply names the ping it answers, so it is about that ping's dialog.
    return { ...hit, explicit: true };
  }
  const latest = lastOutbound(now);
  // A bare message is about the pane, not about whatever dialog happened to be
  // on screen when the last ping went out.
  return latest ? { ...latest, explicit: false } : undefined;
}

// Which fingerprint, if any, this reply has to match. Only a reply that named
// its ping (an explicit Telegram reply, or a button tap) inherits the dialog it
// was sent for; a bare message must not be refused because that dialog is gone.
export function replyFingerprint(target) {
  return target?.explicit ? target.fingerprint : undefined;
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

// A Telegram button lives forever; the dialog it belonged to does not. Before
// any keypress, check that the pane is still asking the same question — a "1"
// meant for "delete the draft?" must not land on whatever dialog is up now.
// The gate is the *ping's* status, not the live one: only a blocked ping is
// about a dialog, while `pane get` lags often enough that a pane it still calls
// `working` can already have the next dialog drawn on it.
//
// "The same question" is decided by the tool call the dialog is about when the
// ping recorded one (`deps.call`), and by the screen's fingerprint otherwise.
// The fingerprint alone refused a real tap: the main session's WebFetch dialog
// stayed up, unanswered, while the fingerprint moved (a dialog whose question
// re-wraps when the pane changes width hashes differently), the tap was called
// stale and the card died with no way left to answer from the phone. The call
// does not move: while it has no result, its dialog has not been answered. A
// form is still judged by the fingerprint, since one call asks every question
// of the form in place.
//
// Returns undefined to go ahead, or a herdr-shaped failure with `stale: true`,
// `reason` ("changed": a dialog is up but not this one, or which one cannot be
// told; "gone": no dialog left, it was answered) and the `screen` it was read
// from, so the caller can offer what is up now instead.
export function staleDialog(paneId, pingStatus, fingerprint, deps = {}) {
  const call = deps.call;
  if (!fingerprint && !call?.id) {
    return undefined;
  }
  const status = String(pingStatus || "").toLowerCase();
  if (status && status !== "blocked" && status !== "unknown") {
    return undefined;
  }
  const read = deps.readScreen ?? ((id) => readPaneScreen(id, {}, deps.run ?? runHerdr));
  const screen = read(paneId);
  if (!String(screen || "").trim()) {
    // Cannot read the pane at all: the old behaviour is still the safer one,
    // because refusing every reply when herdr hiccups is worse than sending.
    console.log(`fingerprint unverified · ${paneId}`);
    return undefined;
  }
  const dialogUp = screenHasLiveDialog(screen) || screenHasOpenMenu(screen);
  const refuse = (reason) => ({ status: 1, stale: true, reason, screen, stderr: "dialog changed since this ping" });
  if (call?.id && !call.asks) {
    const state = (deps.callState ?? callState)(call);
    if (state === "answered") {
      return refuse(dialogUp ? "changed" : "gone");
    }
    if (state === "open") {
      if (!dialogUp) {
        return refuse("gone");
      }
      // Two calls can be open at once (one approved and still running); the
      // dialog up must be this call's. When the screen names no call at all,
      // the fingerprint below decides.
      const onScreen = (deps.screenCall ?? ((text) => sessionDialog(paneId, text, { run: deps.run ?? runHerdr })?.call))(screen);
      if (onScreen?.id === call.id) {
        return undefined;
      }
      if (onScreen?.id) {
        return refuse("changed");
      }
    }
  }
  if (!fingerprint) {
    return undefined;
  }
  if (screenHasLiveDialog(screen) && dialogFingerprint(screen) === fingerprint) {
    return undefined;
  }
  return refuse(dialogUp ? "changed" : "gone");
}

// How a reply is typed depends on whether something is waiting for a keypress,
// and Herdr's status is not always the one to ask: it has called a pane `done`,
// then `idle`, with Claude Code's multi-question form still open. `agent prompt`
// on a pane Herdr thinks is idle submits the text — types it *and* presses
// Enter — so a "1" picks the first choice, the form moves on to its next tab,
// and the Enter answers that one too. A menu on screen overrules the status.
function deliveryStatus(paneId, live, fallbackStatus, deps) {
  if (live === "blocked") {
    return live;
  }
  const read = deps.readScreen ?? ((id) => readPaneScreen(id, {}, deps.run ?? runHerdr));
  if (screenHasOpenMenu(read(paneId))) {
    return "blocked";
  }
  return live || fallbackStatus || "unknown";
}

export function deliverReply(paneId, text, fallbackStatus, options = {}) {
  const run = options.run ?? runHerdr;
  const live = currentPaneStatus(paneId, run);
  const stale = staleDialog(paneId, fallbackStatus, options.fingerprint, options);
  if (stale) {
    return stale;
  }
  const plan = classifyDelivery(deliveryStatus(paneId, live, fallbackStatus, options), text);
  if (plan.mode === "keys") {
    return run(["pane", "send-keys", paneId, ...plan.keys]);
  }
  if (plan.mode === "text-enter") {
    const typed = run(["pane", "send-text", paneId, text]);
    if (herdrFailed(typed)) {
      return typed;
    }
    return run(["pane", "send-keys", paneId, "enter"]);
  }
  const prompted = run(["agent", "prompt", paneId, text]);
  if (isAgentBlockedError(prompted)) {
    // Herdr just contradicted `pane get`: the pane is blocked after all, so the
    // status we checked against was stale. Verify the dialog before typing,
    // otherwise this fallback is a hole straight through the fingerprint.
    const stale = staleDialog(paneId, fallbackStatus, options.fingerprint, options);
    if (stale) {
      return stale;
    }
    const typed = run(["pane", "send-text", paneId, text]);
    if (herdrFailed(typed)) {
      return typed;
    }
    return run(["pane", "send-keys", paneId, "enter"]);
  }
  return prompted;
}

export const REPLY_HELP = "Blocked: tap a choice or type one. Done: send a new instruction.";
export const NO_TARGET = "Reply to a ping so I know which pane.";

// What the delivery path needs from a chat channel: `reply` for an ack, and
// `ping` for a new question with its choices, returning the message id later
// replies will name. Telegram's is built from `deps.send` so the tests can
// record it; Feishu's lives in inbound/feishu.mjs.
export function telegramChannel(deps = {}) {
  const send = deps.send ?? sendTelegram;
  return {
    name: "telegram",
    reply: (text) => send(deps.token, deps.chatId, text, { forceReply: false }),
    ping: (text, { options = [] } = {}) =>
      send(deps.token, deps.chatId, text, {
        forceReply: options.length === 0,
        replyMarkup: optionKeyboard(options),
      }),
  };
}

// `deps` carries the Telegram and herdr edges (`send`, `answer`, `run`) so the
// whole path can be exercised without a network or a live pane; the poller
// passes only the token and chat id and gets the real ones.
export async function handleTelegramUpdate(update, deps = {}) {
  const { token, chatId } = deps;
  const send = deps.send ?? sendTelegram;
  if (update?.callback_query) {
    return handleCallback(update.callback_query, deps);
  }
  const message = update?.message;
  if (!message?.text) {
    return { skipped: "no-text" };
  }
  const text = message.text.trim();
  const paired = await maybePair(message, text, token, send);
  if (paired) {
    return paired;
  }
  if (!chatId || String(message.chat?.id) !== String(chatId)) {
    return { skipped: "chat" };
  }
  const channel = telegramChannel(deps);
  if (!text) {
    return { skipped: "command" };
  }
  // With drover: commands, the off switch, and a line to the main session.
  const settings = deps.settings ?? roleSettings();
  if (rolesActive(settings)) {
    return routeChatMessage(text, {
      channel,
      quotedId: message.reply_to_message?.message_id,
      messageId: message.message_id,
      settings,
      run: deps.run,
      wait: deps.wait,
      now: deps.now,
      enabled: deps.enabled,
      setEnabled: deps.setEnabled,
      channelFor: deps.channelFor,
      deps,
    });
  }
  if (text.startsWith("/")) {
    if (text === "/start" || text.startsWith("/start@") || text === "/help") {
      await channel.reply(REPLY_HELP);
    }
    return { skipped: "command" };
  }
  const target = resolveReplyTarget(message);
  if (!target?.paneId) {
    await channel.reply(NO_TARGET);
    return { skipped: "no-target" };
  }
  return finishDelivery(target, text, { ...deps, channel });
}

async function maybePair(message, text, token, send = sendTelegram) {
  const looksLikePair = Boolean(extractStartPayload(text)) || Boolean(pendingPair() && /^[A-Z0-9]{6,12}$/i.test(text));
  if (!looksLikePair) {
    return undefined;
  }
  const result = consumePairCode(text);
  const chat = message.chat?.id;
  if (!result.ok) {
    if (chat && result.reason !== "no-pending") {
      await send(token, chat, "pair code mismatch or expired. run pair on the host again.", {
        forceReply: false,
      });
    }
    return { skipped: `pair-${result.reason}` };
  }
  if (!chat) {
    return { skipped: "pair-no-chat" };
  }
  const envPath = upsertEnvValue("TELEGRAM_CHAT_ID", chat);
  await send(token, chat, "paired · this machine will send oncall here", { forceReply: false });
  console.log(`paired chat=${chat} env=${envPath}`);
  return { ok: true, paired: String(chat) };
}

async function handleCallback(query, deps) {
  const { token, chatId } = deps;
  const answer = deps.answer ?? telegramAnswerCallback;
  const chat = query?.message?.chat?.id ?? query?.from?.id;
  if (chat !== undefined && String(chat) !== String(chatId) && String(query?.from?.id) !== String(chatId)) {
    console.log(`callback chat mismatch got=${chat} want=${chatId}`);
    return { skipped: "chat" };
  }
  const text = String(query?.data || "").trim();
  if (!text) {
    return { skipped: "no-data" };
  }
  const channel = telegramChannel(deps);
  // With drover, off means nothing from the chat reaches a pane, taps included.
  if (rolesActive(deps.settings ?? roleSettings()) && !(deps.enabled ?? modeEnabled())) {
    await answer(token, query.id, "oncall is off");
    await channel.reply(OFF_NOTICE);
    return { skipped: "off" };
  }
  // A tap always names its own message, so an id we do not know is not a reason
  // to fall back to the most recent ping and press a key into some other pane.
  const record = lookupOutbound(query?.message?.message_id);
  const target = record ? { ...record, explicit: true } : undefined;
  console.log(`callback data=${text} pane=${target?.paneId || "none"}`);
  await answer(token, query.id, target?.paneId ? "sending" : "no pane");
  if (!target?.paneId) {
    await channel.reply("no pane mapped for that button");
    return { skipped: "no-target" };
  }
  return finishDelivery(target, text, { ...deps, channel });
}

// Delivers a reply into its pane and acks it. `deps.channel` is where the ack
// and any follow-on question go; `deps.ack` overrides only the ack, for a
// channel that reports on the message tapped rather than with a new one.
export async function finishDelivery(target, text, deps) {
  const { channel } = deps;
  const ack = deps.ack ?? channel.reply;
  // Which question this reply is about to answer, read before it lands, so the
  // one that replaces it can be told apart from it afterwards.
  const answered = target.status === "blocked" ? liveDialog(target.paneId, deps) : undefined;
  const result = deliverReply(target.paneId, text, target.status, {
    fingerprint: replyFingerprint(target),
    call: target.explicit ? target.call : undefined,
    run: deps.run,
    callState: deps.callState,
    screenCall: deps.screenCall,
  });
  if (result?.stale) {
    return answerStale(target, result, { ...deps, ack });
  }
  const ok = !herdrFailed(result);
  if (ok && target.explicit && target.messageId && target.status === "blocked") {
    markOutbound(target.messageId, { spent: "sent" });
  }
  await ack(
    ok
      ? `sent · ${target.where || target.paneId}`
      : `failed · ${target.where || target.paneId}\n${herdrErrorText(result)}`,
  );
  const outcome = { ok, paneId: target.paneId, mode: classifyDelivery(target.status, text).mode };
  if (ok && answered && (await followForm(target, answered, deps))) {
    outcome.followed = true;
  }
  return outcome;
}

// A reply that was not pressed must not leave the user with a dead card. The
// card it came from is spent either way. With a dialog still up (a different
// one, or one that cannot be told from the screen), a new card for it goes
// out at once, so there is always something to press; with no dialog left,
// the old card says the question was already dealt with, and that is the one
// case where nothing to press is right.
async function answerStale(target, result, deps) {
  const { channel, ack } = deps;
  const run = deps.run ?? runHerdr;
  const where = target.where || target.paneId;
  if (target.messageId) {
    markOutbound(target.messageId, { spent: "stale" });
  }
  if (result.reason !== "changed") {
    console.log(`stale · ${where} · the dialog was already answered, not sent`);
    await ack(`这个确认已经处理过了 · ${where}`);
    return { ok: false, stale: true, handled: true, paneId: target.paneId };
  }
  const screen = result.screen;
  const dialog = sessionDialog(target.paneId, screen, { run });
  const existing = dialog?.call?.id ? usableCardFor(target.paneId, dialog.call.id, { state: deps.callState ?? callState }) : undefined;
  if (existing) {
    console.log(`stale · ${where} · dialog changed, not sent; it already has a card`);
    await ack(`弹框变了，没按 · ${where}\n现在的弹框已经有一张卡片了，请点那一张`);
    return { ok: false, stale: true, paneId: target.paneId };
  }
  console.log(`stale · ${where} · dialog changed, not sent; a new card for the one on screen`);
  // Said first, so on a chat where the ack is its own message it sits above
  // the card it points to.
  await ack(`弹框变了，没按 · ${where}\n已换成下面这张新卡片`);
  const title = target.title || statusTitle({}, {}, "blocked");
  const options = dialogChoices(screen);
  let body = dialog?.body;
  if (!body) {
    saveScreen("last-blocked-screen.txt", screen);
    body = blockedSnippet(screen);
  }
  const message = target.layout === "main" ? mainBlockedText(body) : composeMessage(title, where, "blocked", body);
  try {
    const messageId = await channel.ping(message, { options });
    rememberOutbound({
      messageId,
      paneId: target.paneId,
      status: "blocked",
      where: target.where,
      title,
      fingerprint: dialogFingerprint(screen),
      options,
      channel: channel.name,
      text: message,
      layout: target.layout,
      call: dialog?.call,
    });
    return { ok: false, stale: true, replaced: true, paneId: target.paneId };
  } catch (error) {
    console.error(`replacement card failed · ${where}: ${describeError(error)}`);
    await channel.reply(`新卡片没发出去（${describeError(error)}），请回到电脑处理`).catch(() => {});
    return { ok: false, stale: true, paneId: target.paneId };
  }
}

function liveDialog(paneId, deps) {
  const screen = readPaneScreen(paneId, {}, deps.run ?? runHerdr);
  return screenHasLiveDialog(screen) ? dialogFingerprint(screen) : undefined;
}

// A multi-question form advances in place, tab by tab, and Herdr fires no event
// for the next question. The desktop panel follows a form itself, from inside
// the hook; a chat ping goes out as that hook exits, so answering the first
// question from the phone left every later one sitting in the terminal with
// nobody told. After a reply lands in a dialog, wait for the question that
// replaces it and ping that one too, on the channel the reply came from, under
// the same heading, with its own buttons and fingerprint. Returns whether a
// next question was pinged.
async function followForm(target, answered, deps) {
  const { channel } = deps;
  const run = deps.run ?? runHerdr;
  const where = target.where || target.paneId;
  const next = await nextDialog({
    read: () => readPaneScreen(target.paneId, {}, run),
    status: () => currentPaneStatus(target.paneId, run),
    answered,
    wait: deps.wait,
  });
  if (!next) {
    return false;
  }
  const title = target.title || statusTitle({}, {}, "blocked");
  const options = dialogChoices(next.screen);
  let body = sessionDialogBody(target.paneId, next.screen, { run });
  if (!body) {
    saveScreen("last-blocked-screen.txt", next.screen);
    body = blockedSnippet(next.screen);
  }
  const message = target.layout === "main" ? mainBlockedText(body) : composeMessage(title, where, "blocked", body);
  try {
    const messageId = await channel.ping(message, { options });
    rememberOutbound({
      messageId,
      paneId: target.paneId,
      status: "blocked",
      where: target.where,
      title,
      fingerprint: next.fingerprint,
      options,
      channel: channel.name,
      text: message,
      layout: target.layout,
    });
  } catch (error) {
    // The answer itself went through and was acked; only the next question's
    // ping was lost, and that is worth a line of its own.
    console.error(`follow-on ping failed · ${where}: ${describeError(error)}`);
    return false;
  }
  console.log(`follows on · ${where}`);
  return true;
}

export function pollEnabled() {
  return envFlag("TELEGRAM_POLL", true);
}
