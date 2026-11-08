import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bareToMain,
  channelPaired,
  dialogQuestion,
  lookupAgentByName,
  mainDonePlan,
  modeEnabled,
  pingChannels,
  readPaneScreen,
  readPaneScreenAnsi,
  roleSettings,
  rolesActive,
  runHerdr,
  screenHasOpenMenu,
  sendRemote,
  sessionChatAnswers,
  setMode,
  sleep,
  stateDir,
} from "../lib/index.mjs";
import {
  NO_TARGET,
  finishDelivery,
  herdrErrorText,
  herdrFailed,
  isAgentBlockedError,
  lastOutbound,
  lookupOutbound,
  rememberOutbound,
} from "./reply.mjs";

// With drover, the paired chat is a line to the main session: a message that
// quotes no ping goes to the agent named MAIN_AGENT_NAME, as if the user had
// typed it there. Everything here is off while MAIN_AGENT_NAME is empty.
//
// What reaches the agent's input box is typed into a live terminal, and the
// terminal reads it as keys (measured on Claude Code 2.1.319 and Codex 0.166
// through `herdr agent prompt`): a leading `!` runs a shell command with no
// approval, a leading `/` runs a slash command (`/clear` wiped the session),
// and an ESC inside the text was taken for Alt+D and ate a character. So every
// message is prefixed, which keeps its first character a `[`, and stripped of
// control characters. Newlines stay: both agents take a multi-line paste as
// one submission.

export const CHAT_PREFIX = { feishu: "[飞书] ", telegram: "[Telegram] " };
export const MAX_CHARS = 2000;
// A main session that is restarting, or just ran /clear, has no name for a
// second or two while drover registers it again; a Codex one is registered
// only when the user first writes to it. A message that arrives in that gap
// waits this long before it is turned away.
export const ABSENT_GRACE_MS = 30_000;
export const LATE_NOTICE_MS = 30 * 60_000;
const PENDING_TTL_MS = 6 * 60 * 60_000;
export const INBOX_CHECK_MS = 5000;

export const OFF_NOTICE = "oncall 已关闭，发 /on 打开";

export function helpText(settings = roleSettings()) {
  const bare = bareToMain(settings)
    ? `不引用直接发：送到主会话（herdr 里名为 ${settings.mainAgentName} 的 agent）。`
    : "不引用直接发：送到最近一条通知的 pane。";
  return [
    bare,
    "引用某条通知回复，或点卡片上的按钮：送到那条通知的 agent。",
    "/off 关闭推送和送达，/on 打开，/send 清空终端输入框里没发出的草稿、把暂存的消息送进去，/help 看这条说明。",
  ].join("\n");
}

export function notFoundText(settings = roleSettings()) {
  return `没找到主会话（herdr 里名为 ${settings.mainAgentName} 的 agent），在主会话里跑 drover main-register`;
}

// Control characters out, \r\n and \r to \n, tabs to a space, then at most
// `limit` characters (code points, so a CJK message is cut where it reads).
export function sanitizeForAgent(raw, limit = MAX_CHARS) {
  const text = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "")
    .trim();
  const chars = Array.from(text);
  const truncated = chars.length > limit;
  return { text: truncated ? chars.slice(0, limit).join("").trimEnd() : text, chars: chars.length, truncated };
}

function short(text, limit = 40) {
  const chars = Array.from(String(text ?? "").replace(/\s+/g, " ").trim());
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : chars.join("");
}

// ---------------------------------------------------------------------------
// The draft in the prompt box.
//
// `agent prompt` types after whatever is already in the box and submits both:
// a half-written "草稿半句" went out as "草稿半句[飞书] …". Plain text cannot
// tell a draft from the box's placeholder ("Try …", "Press up to edit queued
// messages", "Ask Codex to do anything"); the styling can, since every one of
// those is drawn dim (SGR 2) and typed text is not. Codex also sprinkles braille
// dots across its box as an animation, in colour but not dim, so those never
// count.

function applySgr(params, dim) {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((code) => Number(code || 0));
  let next = dim;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 38 || code === 48 || code === 58) {
      // A colour's own arguments: 5;n or 2;r;g;b. Read as codes, a green
      // `38;5;2` would switch dim on.
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
      continue;
    }
    if (code === 0 || code === 22) {
      next = false;
    } else if (code === 2) {
      next = true;
    }
  }
  return next;
}

// Each line as a list of { ch, dim }.
export function styledLines(ansi) {
  const text = String(ansi ?? "").replace(/\r/g, "");
  const lines = [];
  let line = [];
  let dim = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === "\x1b") {
      const csi = /^\x1b\[([0-9;:?]*)([ -/]*)([@-~])/.exec(text.slice(i, i + 80));
      if (csi) {
        if (csi[3] === "m") {
          dim = applySgr(csi[1], dim);
        }
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(text.slice(i));
      i += osc ? osc[0].length : 2;
      continue;
    }
    if (ch === "\n") {
      lines.push(line);
      line = [];
      i++;
      continue;
    }
    const code = text.codePointAt(i);
    const glyph = String.fromCodePoint(code);
    line.push({ ch: glyph, dim });
    i += glyph.length;
  }
  lines.push(line);
  return lines;
}

function isRule(text) {
  const trimmed = text.trim();
  return trimmed.length >= 3 && /^[─-╿\s]+$/.test(trimmed);
}

function isBraille(ch) {
  const code = ch.codePointAt(0);
  return code >= 0x2800 && code <= 0x28ff;
}

// Typed text: drawn at normal intensity, and not one of Codex's dots.
function typedCell(cell) {
  return !cell.dim && !isBraille(cell.ch);
}

// The text typed into the prompt box and not sent yet, or "" for an empty box
// (or a screen with no box on it: Claude Code's "❯" between two rules, Codex's
// "›" in its shaded box, both the bottom-most such line on screen).
export function inputDraft(ansi) {
  const lines = styledLines(ansi);
  const plain = lines.map((cells) => cells.map((cell) => cell.ch).join(""));
  let at = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (/^\s{0,2}[❯›](?:\s|$)/.test(plain[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) {
    return "";
  }
  const typed = [];
  for (let i = at; i < lines.length; i++) {
    // The box's own lines: the marker line, then lines indented under it, up
    // to the rule below (Claude Code) or the shaded blank line (Codex).
    if (i > at && (!plain[i].trim() || isRule(plain[i]) || !/^\s{2}\S/.test(plain[i]))) {
      break;
    }
    let cells = lines[i];
    if (i === at) {
      const marker = cells.findIndex((cell) => cell.ch === "❯" || cell.ch === "›");
      cells = cells.slice(marker + 1);
    }
    typed.push(
      cells
        .filter(typedCell)
        .map((cell) => cell.ch)
        .join("")
        .trim(),
    );
  }
  return typed.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Where the main session is, and whether a message can go in now.

// { state, main, question?, draft? } where state is
//   "absent"     no live agent has the name
//   "blocked"    a dialog or a question is waiting: typing would answer it
//   "draft"      the prompt box holds unsent text the message would join
//   "codex-busy" Codex is mid-turn: a message would cut the turn short
//                (measured: the half-written answer was dropped and only the
//                new message was answered)
//   "working"    Claude Code is mid-turn: it queues the message for after
//   "ready"      idle, done or unknown
export function mainState({ settings = roleSettings(), run = runHerdr } = {}) {
  const main = lookupAgentByName(settings.mainAgentName, run);
  if (!main.found) {
    return { state: "absent", main };
  }
  const screen = readPaneScreen(main.paneId, {}, run);
  if (main.status === "blocked" || screenHasOpenMenu(screen)) {
    return { state: "blocked", main, question: dialogQuestion(screen) };
  }
  if (main.kind === "claude" || main.kind === "codex") {
    const draft = inputDraft(readPaneScreenAnsi(main.paneId, run));
    if (draft) {
      return { state: "draft", main, draft };
    }
  }
  if (main.status === "working") {
    return { state: main.kind === "codex" ? "codex-busy" : "working", main };
  }
  return { state: "ready", main };
}

function stashNotice(verdict, settings) {
  switch (verdict.state) {
    case "blocked":
      return `主会话在等确认：${verdict.question || "（确认框）"}。先回那条确认通知；你这条已暂存，确认完自动送`;
    case "draft":
      return `终端输入框里有没发出的内容「${short(verdict.draft)}」，你这条已暂存。回 /send 清空草稿后送入，或者回到电脑处理`;
    case "codex-busy":
      return "主会话正在处理上一件事（Codex 收到新消息会打断当前这一轮），你这条已暂存，它停下就送";
    case "absent":
      return notFoundText(settings);
    default:
      return "你这条已暂存";
  }
}

// Why a message is still waiting, for the notice after LATE_NOTICE_MS.
function waitingReason(verdict, settings) {
  switch (verdict.state) {
    case "blocked":
      return `主会话在等确认：${verdict.question || "（确认框）"}`;
    case "draft":
      return `终端输入框里有没发出的内容「${short(verdict.draft)}」，回 /send 清空后送入`;
    case "codex-busy":
      return "主会话还在处理上一件事";
    case "absent":
      return `没找到名为 ${settings.mainAgentName} 的主会话`;
    default:
      return "主会话暂时收不了";
  }
}

// ---------------------------------------------------------------------------
// The files: the inbox of messages waiting to go in, and the messages that
// went in and still wait for their answer, which the notify hook finds in the
// session record and sends as a reply to each.

function inboxPath() {
  return join(stateDir(), "main-inbox.json");
}

// Every chat message that went into the main session and has not had its
// answer sent back yet (the notify hook finds it in the session record).
function pendingPath() {
  return join(stateDir(), "main-pending.json");
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

export function readInbox() {
  const items = readJson(inboxPath(), []);
  return Array.isArray(items) ? items : [];
}

function writeInbox(items) {
  writeJson(inboxPath(), items);
}

export function rememberPendingAnswer({ id, paneId, channel, messageId, text }, now = Date.now()) {
  const items = livePending(now);
  items.push({
    id: id ?? `${now}-${Math.random().toString(36).slice(2, 8)}`,
    paneId,
    channel,
    messageId: messageId === undefined || messageId === null ? undefined : String(messageId),
    text,
    deliveredAt: now,
  });
  writeJson(pendingPath(), items);
}

function livePending(now) {
  const items = readJson(pendingPath(), []);
  return (Array.isArray(items) ? items : []).filter((item) => item?.paneId && now - Number(item.deliveredAt) < PENDING_TTL_MS);
}

// The chat messages sent into this pane that are still waiting for their
// answer, oldest first. One older than PENDING_TTL_MS is given up on.
export function pendingAnswers(paneId, now = Date.now()) {
  return livePending(now).filter((item) => item.paneId === paneId);
}

export function removePendingAnswer(id, now = Date.now()) {
  writeJson(
    pendingPath(),
    livePending(now).filter((item) => item.id !== id),
  );
}

// ---------------------------------------------------------------------------
// Delivery.

function logLine(outcome, item, detail) {
  return `main inbox · ${outcome} · ${item.chars} chars · ${detail} · ${item.channel}`;
}

function truncatedNote(item) {
  return item.truncated ? `（超过 ${MAX_CHARS} 字，只送了前 ${MAX_CHARS} 字）` : "";
}

function deliveredNotice(state, item, now) {
  const waited = item.stashedAt ? Math.floor((now - item.stashedAt) / 60_000) : 0;
  const base =
    state === "working"
      ? "已送达，主会话正在处理上一件事，会接着看"
      : waited > 0
        ? `已送达主会话（暂存了 ${waited} 分钟）`
        : "已送达主会话";
  return `${base}${truncatedNote(item)}`;
}

// Types one message into the main session. Returns "sent" | "blocked" |
// "failed", with the herdr result.
function typeIntoMain(paneId, item, run) {
  const result = run(["agent", "prompt", paneId, item.text]);
  if (isAgentBlockedError(result)) {
    return { outcome: "blocked", result };
  }
  return { outcome: herdrFailed(result) ? "failed" : "sent", result };
}

// A message for the main session: sent now when it can go in, otherwise kept
// in the inbox for the poller to send when it can. Always says which on the
// channel it came from, except while the main session's name is missing, when
// the poller decides within ABSENT_GRACE_MS. Returns the outcome.
export async function routeToMain(raw, { channel, messageId, settings = roleSettings(), run = runHerdr, now = Date.now(), log = console.log } = {}) {
  const clean = sanitizeForAgent(raw);
  if (!clean.text) {
    return { skipped: "empty" };
  }
  const item = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    text: `${CHAT_PREFIX[channel.name] ?? CHAT_PREFIX.feishu}${clean.text}`,
    chars: clean.chars,
    truncated: clean.truncated,
    channel: channel.name,
    messageId: messageId === undefined || messageId === null ? undefined : String(messageId),
    at: now,
  };
  const waiting = readInbox();
  if (waiting.length) {
    // Order is kept: nothing overtakes a message that is already waiting.
    writeInbox([...waiting, { ...item, stashedAt: now, reason: "queued" }]);
    log(logLine("stashed", item, `behind ${waiting.length} waiting`));
    await channel.reply(`你这条已暂存，排在前面 ${waiting.length} 条后面，主会话能接收时按顺序送`);
    return { ok: true, stashed: true, reason: "queued" };
  }
  const verdict = mainState({ settings, run });
  if (verdict.state === "ready" || verdict.state === "working") {
    const typed = typeIntoMain(verdict.main.paneId, item, run);
    if (typed.outcome === "sent") {
      rememberPendingAnswer({ id: item.id, paneId: verdict.main.paneId, channel: item.channel, messageId: item.messageId, text: item.text }, now);
      log(logLine("delivered", item, verdict.main.status || verdict.state));
      await channel.reply(deliveredNotice(verdict.state, item, now));
      return { ok: true, delivered: true, paneId: verdict.main.paneId, state: verdict.state };
    }
    if (typed.outcome === "failed") {
      log(logLine("refused", item, `herdr: ${herdrErrorText(typed.result)}`));
      await channel.reply(`没送进去：${herdrErrorText(typed.result)}`);
      return { ok: false, failed: true };
    }
    verdict.state = "blocked";
  }
  writeInbox([{ ...item, stashedAt: now, reason: verdict.state, ...(verdict.state === "absent" ? { absentSince: now } : {}) }]);
  log(logLine("stashed", item, verdict.state));
  if (verdict.state !== "absent") {
    await channel.reply(`${stashNotice(verdict, settings)}${truncatedNote(item)}`);
  }
  return { ok: true, stashed: true, reason: verdict.state };
}

// One pass of the poller over the inbox: the first message goes in as soon as
// the main session can take it; one that waited for a name past the grace is
// turned away; one waiting longer than LATE_NOTICE_MS is mentioned once. One
// message per pass: after it the main session is busy with it, which Claude
// Code queues behind and Codex waits out.
export async function drainInbox({
  channelFor,
  settings = roleSettings(),
  run = runHerdr,
  now = Date.now(),
  enabled = modeEnabled(),
  log = console.log,
} = {}) {
  const items = readInbox();
  if (!items.length) {
    return { idle: true };
  }
  const say = async (item, text) => {
    const channel = channelFor?.(item.channel);
    if (!channel) {
      log(`main inbox · ${item.channel} is not paired any more, notice dropped`);
      return;
    }
    try {
      await channel.reply(text);
    } catch (error) {
      log(`main inbox · notice failed · ${item.channel}: ${error?.message || error}`);
    }
  };
  if (!rolesActive(settings)) {
    writeInbox([]);
    for (const item of items) {
      log(logLine("refused", item, "MAIN_AGENT_NAME is no longer set"));
      await say(item, `直达主会话已经关掉了，这条没送：「${short(item.text)}」`);
    }
    return { dropped: items.length };
  }
  if (!enabled) {
    return { held: "off" };
  }
  const [first, ...rest] = items;
  const verdict = mainState({ settings, run });
  if (verdict.state === "ready" || verdict.state === "working") {
    const typed = typeIntoMain(verdict.main.paneId, first, run);
    if (typed.outcome === "sent") {
      writeInbox(rest);
      rememberPendingAnswer({ id: first.id, paneId: verdict.main.paneId, channel: first.channel, messageId: first.messageId, text: first.text }, now);
      log(logLine("delivered", first, `${verdict.main.status || verdict.state}, after waiting`));
      await say(first, deliveredNotice(verdict.state, first, now));
      return { delivered: first.id };
    }
    if (typed.outcome === "failed") {
      log(`main inbox · still waiting · herdr: ${herdrErrorText(typed.result)}`);
      return { waiting: "herdr" };
    }
    verdict.state = "blocked";
  }
  // The name can be missing for a moment while drover registers the session
  // again; only a gap that outlasts the grace turns the message away.
  const absentSince = verdict.state === "absent" ? (first.absentSince ?? now) : undefined;
  if (absentSince !== undefined && now - absentSince >= ABSENT_GRACE_MS) {
    writeInbox(rest);
    log(logLine("refused", first, `no agent named ${settings.mainAgentName}`));
    await say(first, notFoundText(settings));
    return { refused: first.id };
  }
  const late = items.filter((item) => !item.lateNoticeAt && now - Number(item.at) >= LATE_NOTICE_MS);
  writeInbox(
    items.map((item, index) => {
      const next = { ...item };
      if (index === 0) {
        next.reason = verdict.state;
        next.absentSince = absentSince;
      }
      if (late.includes(item)) {
        next.lateNoticeAt = now;
      }
      return next;
    }),
  );
  for (const item of late) {
    await say(item, `还没送进去：「${short(item.text)}」（${waitingReason(verdict, settings)}），仍在暂存`);
  }
  return { waiting: verdict.state };
}

// /send: empties the prompt box, then lets the inbox go. The draft is gone
// from the box afterwards, so its text goes back in the reply (Claude Code can
// also bring it back with Ctrl+Y).
export async function clearDraft(paneId, { run = runHerdr, wait = sleep, attempts = 20 } = {}) {
  let first = "";
  for (let i = 0; i < attempts; i++) {
    const draft = inputDraft(readPaneScreenAnsi(paneId, run));
    if (i === 0) {
      first = draft;
    }
    if (!draft) {
      return { ok: true, draft: first };
    }
    // ctrl+u empties the line the cursor is on; backspace then joins the line
    // above, so a multi-line draft goes one line per round.
    const keys = run(["pane", "send-keys", paneId, "ctrl+u", "backspace"]);
    if (herdrFailed(keys)) {
      return { ok: false, draft: first, error: herdrErrorText(keys) };
    }
    await wait(150);
  }
  const left = inputDraft(readPaneScreenAnsi(paneId, run));
  return left ? { ok: false, draft: first, error: "the draft is still there" } : { ok: true, draft: first };
}

async function sendCommand({ channel, settings, run, wait, now, log, channelFor }) {
  const items = readInbox();
  const verdict = mainState({ settings, run });
  if (verdict.state === "absent") {
    await channel.reply(notFoundText(settings));
    return { skipped: "absent" };
  }
  // A dialog's cursor line ("❯ 1. Yes", Codex "› 1. Yes") looks like a box
  // with text in it; clearing keys must never go into a dialog.
  if (verdict.state === "blocked") {
    await channel.reply(`主会话在等确认：${verdict.question || "（确认框）"}。先回那条确认通知，没有清草稿`);
    return { skipped: "blocked" };
  }
  const cleared = verdict.state === "draft" ? await clearDraft(verdict.main.paneId, { run, wait }) : { ok: true, draft: "" };
  if (!cleared.ok) {
    await channel.reply(`草稿没清掉，没送：${cleared.error}`);
    return { ok: false, draft: cleared.draft };
  }
  const head = cleared.draft ? `已清空终端草稿「${short(cleared.draft, 60)}」` : "终端输入框是空的";
  if (!items.length) {
    await channel.reply(`${head}，没有暂存的消息`);
    return { ok: true, cleared: Boolean(cleared.draft), sent: 0 };
  }
  await channel.reply(`${head}，暂存的 ${items.length} 条按顺序送入`);
  const outcome = await drainInbox({ channelFor: channelFor ?? (() => channel), settings, run, now, log });
  return { ok: true, cleared: Boolean(cleared.draft), outcome };
}

// The chat's own commands. Only while MAIN_AGENT_NAME is set; 0.6.6 answered
// /help and dropped the rest, and that is what it does without drover.
export async function chatCommand(text, { channel, settings, run, wait, now, log, setEnabled = setMode, channelFor }) {
  const command = text.trim().toLowerCase().split(/\s+/)[0].replace(/@.*$/, "");
  if (command === "/help" || command === "help" || command === "/start" || command === "start") {
    await channel.reply(helpText(settings));
    return { skipped: "command", command: "help" };
  }
  if (command === "/off") {
    setEnabled(false);
    log("chat · /off · oncall disabled");
    await channel.reply("oncall 已关闭：不再推送，聊天里发来的消息也不再送进 agent。发 /on 打开");
    return { ok: true, command: "off" };
  }
  if (command === "/on") {
    setEnabled(true);
    log("chat · /on · oncall enabled");
    await channel.reply("oncall 已打开");
    return { ok: true, command: "on" };
  }
  if (command === "/send") {
    return { command: "send", ...(await sendCommand({ channel, settings, run, wait, now, log, channelFor })) };
  }
  await channel.reply(`不认识的命令 ${command}，发 /help 看说明`);
  return { skipped: "command", command };
}

function isCommand(text) {
  return text.startsWith("/") || /^(help|start)$/i.test(text);
}

// One text message from the paired chat, while MAIN_AGENT_NAME is set.
// `quotedId` is the ping it quotes, if it quotes one. Answers to a dialog (a
// quoted blocked ping) still go in as keys, through finishDelivery; anything
// that would be typed into the main session as a prompt goes through
// routeToMain, prefix and all.
export async function routeChatMessage(
  text,
  {
    channel,
    quotedId,
    messageId,
    settings = roleSettings(),
    run = runHerdr,
    wait,
    now = Date.now(),
    enabled = modeEnabled(),
    setEnabled,
    log = console.log,
    channelFor,
    deps = {},
  },
) {
  if (isCommand(text)) {
    return chatCommand(text, { channel, settings, run, wait, now, log, setEnabled, channelFor });
  }
  if (!enabled) {
    log(`chat · refused · oncall is off · ${channel.name}`);
    await channel.reply(OFF_NOTICE);
    return { skipped: "off" };
  }
  let mainPane;
  const isMain = (paneId) => {
    mainPane ??= lookupAgentByName(settings.mainAgentName, run).paneId ?? null;
    return Boolean(paneId) && paneId === mainPane;
  };
  const hit = lookupOutbound(quotedId, now);
  if (hit) {
    if (hit.status !== "blocked" && isMain(hit.paneId)) {
      return routeToMain(text, { channel, messageId, settings, run, now, log });
    }
    return finishDelivery({ ...hit, explicit: true }, text, { ...deps, run, wait, channel });
  }
  if (bareToMain(settings)) {
    return routeToMain(text, { channel, messageId, settings, run, now, log });
  }
  const latest = lastOutbound(now);
  if (!latest?.paneId) {
    await channel.reply(NO_TARGET);
    return { skipped: "no-target" };
  }
  if (latest.status !== "blocked" && isMain(latest.paneId)) {
    return routeToMain(text, { channel, messageId, settings, run, now, log });
  }
  return finishDelivery({ ...latest, explicit: false }, text, { ...deps, run, wait, channel });
}

// ---------------------------------------------------------------------------
// The main session's done (called by the notify hook).

// What this done sends: the answers to chat messages still waiting for one,
// each found in its own turn of the session record (not "whatever ended
// next": a Monitor event can start the next turn before Herdr sees a done),
// then this turn per MAIN_DONE_PING (see mainDonePlan). An answer whose turn
// wrote no text is dropped from the waiting list; one whose turn is still open
// waits for the next done.
export async function mainDonePings({
  paneId,
  where,
  turnAnswer,
  apiErrorText,
  settings = roleSettings(),
  now = Date.now(),
  run = runHerdr,
  env = process.env,
  wait,
  log = console.log,
}) {
  const pending = pendingAnswers(paneId, now);
  const answers = [];
  if (!apiErrorText && pending.length) {
    const found = await sessionChatAnswers(paneId, pending, { run, env, ...(wait ? { wait } : {}) });
    if (found.noSession) {
      // No session record to look in: this turn's answer is the best there
      // is, and it goes to the oldest message, as the first version did.
      if (turnAnswer) {
        answers.push({ ...pending[0], answer: turnAnswer });
      }
      log(`chat answer · ${where} · no session record to look in, sending this turn's answer`);
    } else {
      for (const item of found.answers) {
        const record = pending.find((entry) => entry.id === item.id);
        const which = `${record.channel} message ${record.messageId}`;
        if (item.state === "answered") {
          answers.push({ ...record, answer: item.answer });
        } else if (item.state === "empty") {
          removePendingAnswer(item.id, now);
          log(`chat answer · ${where} · the turn of ${which} wrote no text, nothing to send`);
        } else {
          log(`chat answer · ${where} · ${which}: its turn is ${item.state === "open" ? "not answered yet" : "not in the session record yet"}, waiting`);
        }
      }
    }
  }
  return mainDonePlan({
    mode: settings.mainDonePing,
    marker: settings.mainRelayMarker,
    chatAnswers: answers,
    turnAnswer,
    apiErrorText,
    waiting: pending.at(-1),
  });
}

const PING_KINDS = {
  chat: "the answer to a chat message",
  relay: "a relay",
  done: "this turn (MAIN_DONE_PING=always)",
  "api-error": "the turn ended on an API error",
};

// Sends what mainDonePings decided, bare: the main session's own words, no
// title and no location line. A chat answer goes back, as a reply, to the
// chat the question came from; the rest go to every channel CHANNEL picks.
// A chat message leaves the waiting list once its answer went out.
export async function sendMainPings(
  pings,
  { paneId, where, title, channels, send = sendRemote, paired = channelPaired, describe, log = console.log, error = console.error, now = Date.now() },
) {
  for (const ping of pings) {
    const origin = ping.replyTo?.channel;
    const targets = origin && paired(origin) ? [origin] : channels;
    let delivered = false;
    log(`done · ${where} · ${PING_KINDS[ping.kind]}${ping.replyTo ? `, as a reply to ${origin} message ${ping.replyTo.messageId}` : ""}`);
    await pingChannels(targets, ping.text, {
      status: "done",
      where,
      send,
      log,
      error,
      ...(describe ? { describe } : {}),
      replyTo: (channel) => (ping.replyTo && channel === origin ? ping.replyTo.messageId : undefined),
      sent: (channel, messageId) => {
        delivered = true;
        rememberOutbound({ messageId, paneId, status: "done", where, title, channel, text: ping.text, layout: "main" }, now);
      },
    });
    if (ping.kind === "chat" && delivered) {
      removePendingAnswer(ping.id, now);
    }
  }
}

// The poller's loop around drainInbox, behind the same queue as every other
// delivery.
export async function inboxLoop({ reload = () => {}, serial = (work) => work(), channelFor, every = INBOX_CHECK_MS } = {}) {
  while (true) {
    try {
      reload();
      if (readInbox().length) {
        await serial(() => drainInbox({ channelFor }));
      }
    } catch (error) {
      console.error(`main inbox check failed · ${error?.message || error}`);
    }
    await sleep(every);
  }
}
