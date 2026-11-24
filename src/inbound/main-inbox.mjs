import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  actionCommand,
  attachmentLine,
  bareToMain,
  channelPaired,
  chatPartsText,
  dialogQuestion,
  herdrSocket,
  lookupAgentByName,
  mainDonePlan,
  modeEnabled,
  notOwnerReason,
  ownership,
  ownershipLines,
  paneStatePath,
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
  textParts,
  tryLock,
  undeliveredNote,
  unlock,
  writeFileAtomic,
} from "../lib/index.mjs";
import {
  NO_TARGET,
  aboutTestPing,
  answerTestPing,
  finishDelivery,
  herdrErrorText,
  herdrFailed,
  isAgentBlockedError,
  lastOutbound,
  lookupOutbound,
  readyChatParts,
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
//
// The chat is not the only way in: drover's task board, on this machine, sends
// what the user clicked (`[看板] 全部收尾：…`) through send-main.mjs, the same
// way. The board is not a chat. Its notice goes back on send-main's output,
// there is no chat to answer on, so nothing waits for its answer in
// main-pending.json, and the chat's off switch does not hold it.

export const BOARD = "board";
export const CHAT_PREFIX = { feishu: "[飞书] ", telegram: "[Telegram] ", [BOARD]: "[看板] " };
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
// What a message about a test ping is told, by the way it is about one (see
// aboutTestPing in reply.mjs).
export const TEST_PING_NOTICE = {
  quoted: "这是测试通知，这条没有送进任何 pane。要回答 agent，请引用真实的通知回复",
  latest: "最近一条通知是测试通知，这条没有送进任何 pane。要回答 agent，请引用真实的通知回复",
};

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

// herdr prints an error as one line of JSON on stderr
// ({"id":…,"error":{"code","message"}}); a person is shown `code: message`,
// and whatever else it printed as it is.
function herdrReason(error) {
  const line = String(error ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) {
    return "herdr gave no answer";
  }
  try {
    const failure = JSON.parse(line).error;
    return [failure.code, failure.message].filter(Boolean).join(": ").slice(0, 200) || line.slice(0, 200);
  } catch {
    return line.slice(0, 200);
  }
}

// herdr cannot be reached, which is not "no agent has that name". The two used
// to be one: when the poller was left talking to a herdr server that had
// stopped, every message came back "没找到主会话…跑 drover main-register", while
// the main session sat registered in the user's own herdr. The socket is the
// one this process talks to, so the user can tell which herdr Oncall is waiting
// for. Returns the sentence, and the same in English for the log.
function herdrDown(main) {
  const socket = herdrSocket().path;
  const reason = herdrReason(main?.error);
  return { text: `herdr 连不上（${socket}）：${reason}`, where: `herdr 连不上（${socket}）`, log: `herdr unreachable at ${socket}: ${reason}` };
}

// A new message is turned away at once. Nothing says this herdr is coming
// back soon, and the reply is the main way the user learns that the herdr
// Oncall belongs to is gone, so it says how to move Oncall to the one in use.
export function unreachableText(main) {
  return `没送进去：${herdrDown(main).text}。Oncall 归属的这个 herdr 没在运行；它起来以后再发一次，或者在你现在用的 herdr 里跑一次 Restart reply poller（${actionCommand("poll")}）把 Oncall 切过去`;
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

// A chat message as the main session's prompt: its words cleaned and within
// `limit` characters, each image on a line of its own where it was. Only the
// words count toward the limit and only words are cut: an image line past the
// cut still goes in, in its place after the words that did. `chars` counts the
// words alone.
export function composeForAgent(parts, limit = MAX_CHARS) {
  const lines = [];
  let left = limit;
  let chars = 0;
  let truncated = false;
  for (const part of parts) {
    if (part.type !== "text") {
      lines.push(attachmentLine(part));
      continue;
    }
    const clean = sanitizeForAgent(part.text, left);
    chars += clean.chars;
    truncated ||= clean.truncated;
    left -= Array.from(clean.text).length;
    if (clean.text) {
      lines.push(clean.text);
    }
  }
  return { text: lines.join("\n"), chars, truncated };
}

function short(text, limit = 40) {
  // An image's path says nothing in a one-line reminder.
  const shown = String(text ?? "").replace(/\[图片\] [^\n]*/g, "[图片]");
  const chars = Array.from(shown.replace(/\s+/g, " ").trim());
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

// Why nobody was found by the main session's name: herdr itself cannot be
// reached, or it answered and nobody has the name (which is also what a list
// that failed for any other reason counts as: no answer this time).
function missing(main) {
  return main.unreachable ? "unreachable" : "absent";
}

// { state, main, question?, draft? } where state is
//   "unreachable" there is no herdr to ask: no telling who is there
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
    return { state: missing(main), main };
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
    case "unreachable":
      return herdrDown(verdict.main).where;
    default:
      return "主会话暂时收不了";
  }
}

// The board shows its notice for a few seconds after the click: one line, and
// nothing a chat would do about it (no /send, no 确认通知 to answer first).
function boardStashNotice(verdict, settings) {
  switch (verdict.state) {
    case "blocked":
      return "主会话在等确认，已排队，确认完自动送";
    case "draft":
      return "主会话输入框里有没发出的内容，已排队，发出或清空后自动送";
    case "codex-busy":
      return "主会话正在处理上一件事，已排队，它停下就送";
    case "absent":
      return `没找到主会话（herdr 里名为 ${settings.mainAgentName} 的 agent），已排队，${ABSENT_GRACE_MS / 1000} 秒内没出现就不送了`;
    default:
      return "已排队";
  }
}

// The off switch holds what came from the chat. The board's messages go past
// it, and past the chat messages it holds in front of them.
function mayGoNow(item, enabled) {
  return enabled || item.channel === BOARD;
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
  return paneStatePath("main-pending.json");
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Both files have readers outside the lock below (`status`, the idle check of
// the inbox loop, the notify hook looking for a waiting chat message), so a
// whole file is put in place, never rewritten in place.
function writeJson(path, value) {
  writeFileAtomic(path, JSON.stringify(value));
}

export function readInbox() {
  const items = readJson(inboxPath(), []);
  return Array.isArray(items) ? items : [];
}

function writeInbox(items) {
  writeJson(inboxPath(), items);
}

// The inbox and the main session's input box had one writer, the poller, whose
// serial() queue kept its deliveries apart. send-main.mjs is a second process,
// and without a lock a click that lands while the poller drains is lost: the
// poller writes back the inbox it read before the click was added. So reading
// the inbox, typing into the main session and writing the inbox back happen
// under this lock, in both processes; replies to the chat go out after it is
// released. A lock whose holder is gone, or that is older than
// INBOX_LOCK_STALE_MS (no delivery takes that long), is taken over.
export const INBOX_LOCK_WAIT_MS = 20_000;
const INBOX_LOCK_STALE_MS = 60_000;

function lockPath() {
  return join(stateDir(), "main-inbox.lock");
}

export async function withInboxLock(work, { timeoutMs = INBOX_LOCK_WAIT_MS, wait = sleep } = {}) {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (!tryLock(path, { staleMs: INBOX_LOCK_STALE_MS })) {
    if (Date.now() >= deadline) {
      throw new Error(`主会话的投递正忙，等了 ${Math.round(timeoutMs / 1000)} 秒还没轮到`);
    }
    await wait(100);
  }
  try {
    return await work();
  } finally {
    unlock(path);
  }
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

// What of the message did not go in: words past the limit, images that could
// not be fetched, a video. "" when all of it did.
function itemNote(item) {
  const notes = [];
  if (item.truncated) {
    notes.push(`超过 ${MAX_CHARS} 字，只送了前 ${MAX_CHARS} 字`);
  }
  if (item.missing) {
    notes.push(item.missing);
  }
  return notes.length ? `（${notes.join("；")}）` : "";
}

function deliveredNotice(state, item, now) {
  const waited = item.stashedAt ? Math.floor((now - item.stashedAt) / 60_000) : 0;
  const base =
    state === "working"
      ? "已送达，主会话正在处理上一件事，会接着看"
      : waited > 0
        ? `已送达主会话（暂存了 ${waited} 分钟）`
        : "已送达主会话";
  return `${base}${itemNote(item)}`;
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

// A message for the main session (its parts, see lib/chat-images.mjs, images
// already fetched): sent now when it can go in, otherwise kept in the inbox
// for the poller to send when it can. A chat always hears which, as a reply,
// except while the main session's name is missing, when the poller decides
// within ABSENT_GRACE_MS; the board's message gets its notice in the result
// instead. `enabled` is the off switch, which a chat message never gets here
// past. Returns the outcome.
export async function routeToMain(
  parts,
  { channel, messageId, settings = roleSettings(), run = runHerdr, now = Date.now(), log = console.log, enabled = true } = {},
) {
  const clean = composeForAgent(parts);
  if (!clean.text) {
    return { skipped: "empty" };
  }
  const item = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    text: `${CHAT_PREFIX[channel.name] ?? CHAT_PREFIX.feishu}${clean.text}`,
    chars: clean.chars,
    truncated: clean.truncated,
    missing: undeliveredNote(parts) || undefined,
    channel: channel.name,
    messageId: messageId === undefined || messageId === null ? undefined : String(messageId),
    at: now,
  };
  const placed = await withInboxLock(() => placeInMain(item, { settings, run, now, log, enabled }));
  if (item.channel === BOARD) {
    return { ...placed.outcome, notice: placed.board };
  }
  if (placed.chat) {
    await channel.reply(placed.chat);
  }
  return placed.outcome;
}

// A message that can go in now is typed in. Returns what to answer, or nothing
// when the main session turned out to be in a dialog after all (herdr answered
// agent_blocked), which leaves the message to be kept like any other.
function typeNow(item, verdict, { run, now, log }) {
  const typed = typeIntoMain(verdict.main.paneId, item, run);
  if (typed.outcome === "sent") {
    if (item.channel !== BOARD) {
      rememberPendingAnswer({ id: item.id, paneId: verdict.main.paneId, channel: item.channel, messageId: item.messageId, text: item.text }, now);
    }
    log(logLine("delivered", item, verdict.main.status || verdict.state));
    return {
      outcome: { ok: true, delivered: true, paneId: verdict.main.paneId, state: verdict.state },
      chat: deliveredNotice(verdict.state, item, now),
      board: `${verdict.state === "working" ? "已送进主会话，它做完手上这件就看" : "已送进主会话"}${itemNote(item)}`,
    };
  }
  if (typed.outcome === "failed") {
    log(logLine("refused", item, `herdr: ${herdrErrorText(typed.result)}`));
    const text = `没送进去：${herdrErrorText(typed.result)}`;
    return { outcome: { ok: false, failed: true }, chat: text, board: text };
  }
  return undefined;
}

// herdr did not answer: the message is turned away now, not kept.
function turnedAway(item, verdict, log) {
  const down = herdrDown(verdict.main);
  log(logLine("refused", item, down.log));
  return { outcome: { ok: false, failed: true }, chat: unreachableText(verdict.main), board: down.text };
}

// routeToMain's decision, under the inbox lock: the outcome, and what to tell
// a chat ("" for nothing) or the board.
function placeInMain(item, { settings, run, now, log, enabled }) {
  // Asked first, before the line is looked at: with herdr gone, a message
  // must not be told "queued behind N others" and left to find out half an
  // hour later. What is already waiting stays where it is.
  const verdict = mainState({ settings, run });
  if (verdict.state === "unreachable") {
    return turnedAway(item, verdict, log);
  }
  const waiting = readInbox();
  const stash = (reason, extra = {}) => writeInbox([...waiting, { ...item, stashedAt: now, reason, ...extra }]);
  // Order is kept: nothing overtakes a message that is already waiting, except
  // one the off switch holds.
  const ahead = waiting.filter((entry) => mayGoNow(entry, enabled)).length;
  if (ahead) {
    stash("queued");
    log(logLine("stashed", item, `behind ${ahead} waiting`));
    return {
      outcome: { ok: true, stashed: true, reason: "queued" },
      chat: `你这条已暂存，排在前面 ${ahead} 条后面，主会话能接收时按顺序送${itemNote(item)}`,
      board: `前面还有 ${ahead} 条在排队，已排在后面，按顺序送${itemNote(item)}`,
    };
  }
  if (verdict.state === "ready" || verdict.state === "working") {
    const answered = typeNow(item, verdict, { run, now, log });
    if (answered) {
      return answered;
    }
    verdict.state = "blocked";
  }
  stash(verdict.state, verdict.state === "absent" ? { absentSince: now } : {});
  log(logLine("stashed", item, verdict.state));
  return {
    outcome: { ok: true, stashed: true, reason: verdict.state },
    // A missing name is most likely drover registering the session again
    // right now: a chat hears of it only once that outlasts the grace.
    chat: verdict.state === "absent" ? "" : `${stashNotice(verdict, settings)}${itemNote(item)}`,
    board: `${boardStashNotice(verdict, settings)}${itemNote(item)}`,
  };
}

// One pass of the poller over the inbox: the first message goes in as soon as
// the main session can take it; one that waited for a name past the grace is
// turned away; one waiting longer than LATE_NOTICE_MS is mentioned once. One
// message per pass: after it the main session is busy with it, which Claude
// Code queues behind and Codex waits out. While the switch is off, the first
// message is the first one from the board. The chat hears of its messages
// once the lock is released; the board's outcome is in the log line alone.
export async function drainInbox({
  channelFor,
  settings = roleSettings(),
  run = runHerdr,
  now = Date.now(),
  enabled = modeEnabled(),
  log = console.log,
} = {}) {
  const notices = [];
  const result = await withInboxLock(() => drainFirst({ settings, run, now, enabled, log, say: (item, text) => notices.push([item, text]) }));
  for (const [item, text] of notices) {
    if (item.channel === BOARD) {
      continue;
    }
    const channel = channelFor?.(item.channel);
    if (!channel) {
      log(`main inbox · ${item.channel} is not paired any more, notice dropped`);
      continue;
    }
    try {
      await channel.reply(text);
    } catch (error) {
      log(`main inbox · notice failed · ${item.channel}: ${error?.message || error}`);
    }
  }
  return result;
}

function drainFirst({ settings, run, now, enabled, log, say }) {
  const items = readInbox();
  if (!items.length) {
    return { idle: true };
  }
  if (!rolesActive(settings)) {
    writeInbox([]);
    for (const item of items) {
      log(logLine("refused", item, "MAIN_AGENT_NAME is no longer set"));
      say(item, `直达主会话已经关掉了，这条没送：「${short(item.text)}」`);
    }
    return { dropped: items.length };
  }
  const first = items.find((item) => mayGoNow(item, enabled));
  if (!first) {
    return { held: "off" };
  }
  const rest = items.filter((item) => item !== first);
  const verdict = mainState({ settings, run });
  if (verdict.state === "ready" || verdict.state === "working") {
    const typed = typeIntoMain(verdict.main.paneId, first, run);
    if (typed.outcome === "sent") {
      writeInbox(rest);
      if (first.channel !== BOARD) {
        rememberPendingAnswer({ id: first.id, paneId: verdict.main.paneId, channel: first.channel, messageId: first.messageId, text: first.text }, now);
      }
      log(logLine("delivered", first, `${verdict.main.status || verdict.state}, after waiting`));
      say(first, deliveredNotice(verdict.state, first, now));
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
    say(first, notFoundText(settings));
    return { refused: first.id };
  }
  // A message already waiting when herdr stops answering is kept, not turned
  // away: it was accepted, and it goes in when herdr is back.
  noteOutage(verdict, first, log);
  const late = items.filter((item) => mayGoNow(item, enabled) && !item.lateNoticeAt && now - Number(item.at) >= LATE_NOTICE_MS);
  writeInbox(
    items.map((item) => {
      const next = { ...item };
      if (item === first) {
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
    say(item, `还没送进去：「${short(item.text)}」（${waitingReason(verdict, settings)}），仍在暂存`);
  }
  return { waiting: waitingOn(verdict.state) };
}

// What a pass that sent nothing reports it is waiting on. herdr not answering
// goes by the name the failed-prompt branch above already uses.
function waitingOn(state) {
  return state === "unreachable" ? "herdr" : state;
}

// Said once per outage: the first item's `reason` is what the last pass found.
function noteOutage(verdict, first, log) {
  if (verdict.state === "unreachable" && first.reason !== "unreachable") {
    log(`main inbox · still waiting · ${herdrDown(verdict.main).log}`);
  }
}

// What send-main.mjs prints for drover's task board (the contract with drover,
// see CLAUDE.md): the text goes into the main session as `[看板] <text>`, now
// or through the inbox, whether or not the chat's switch is on.
//   { ok: true, result: "delivered", reason: "ready"|"working", notice }
//   { ok: true, result: "queued", reason: "queued"|"blocked"|"draft"|"codex-busy"|"absent", notice }
//   { ok: false, error }
// `owned` is asked only once it is known there is a main session to send to,
// so without drover nothing is read and herdr is not asked.
export async function sendFromBoard(
  text,
  { settings = roleSettings(), run = runHerdr, now = Date.now(), enabled = modeEnabled(), log = console.log, owned = () => ownership({ run }) } = {},
) {
  if (!rolesActive(settings)) {
    return { ok: false, error: "MAIN_AGENT_NAME 没设（不是 drover 环境），没有主会话可送" };
  }
  const elsewhere = boardElsewhere(owned(), log);
  if (elsewhere) {
    return elsewhere;
  }
  const outcome = await routeToMain(textParts(text), { channel: { name: BOARD }, settings, run, now, log, enabled });
  if (outcome.skipped) {
    return { ok: false, error: "--text 是空的，没送" };
  }
  if (!outcome.ok) {
    return { ok: false, error: outcome.notice };
  }
  return outcome.delivered
    ? { ok: true, result: "delivered", reason: outcome.state, notice: outcome.notice }
    : { ok: true, result: "queued", reason: outcome.reason, notice: outcome.notice };
}

// A board running in a herdr session that does not own Oncall is refused: the
// agent it would find by the main session's name there is not the main session
// Oncall serves. Returns what to print then, and nothing when the session is
// the owner.
function boardElsewhere(own, log) {
  for (const line of ownershipLines(own)) {
    log(line);
  }
  if (own.mine) {
    return undefined;
  }
  log(`send-main · refused · ${notOwnerReason(own)}`);
  const owner = own.owner?.socket ?? "还没有";
  return {
    ok: false,
    error: `这个 herdr 会话（${own.socket}）不是 Oncall 的归属会话（归属：${owner}），没送；要切过来，在这个 herdr 里跑 ${actionCommand("poll")}`,
  };
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

// Why /send does nothing in these states, by state. A dialog's cursor line
// ("❯ 1. Yes", Codex "› 1. Yes") looks like a box with text in it; clearing
// keys must never go into a dialog.
const SEND_REFUSED = {
  unreachable: (verdict) => `${herdrDown(verdict.main).text}，没清草稿也没送`,
  absent: (_verdict, settings) => notFoundText(settings),
  blocked: (verdict) => `主会话在等确认：${verdict.question || "（确认框）"}。先回那条确认通知，没有清草稿`,
};

async function sendCommand({ channel, settings, run, wait, now, log, channelFor }) {
  const items = readInbox();
  const verdict = mainState({ settings, run });
  const refused = SEND_REFUSED[verdict.state];
  if (refused) {
    await channel.reply(refused(verdict, settings));
    return { skipped: verdict.state };
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

export function isChatCommand(text) {
  return text.startsWith("/") || /^(help|start)$/i.test(text);
}

// One message from the paired chat (its parts, see lib/chat-images.mjs),
// while MAIN_AGENT_NAME is set. `quotedId` is the ping it quotes, if it quotes
// one; `fetchImages` fetches its images, which happens only once it is known
// to go somewhere. Answers to a dialog (a quoted blocked ping) still go in as
// keys, through finishDelivery; anything that would be typed into the main
// session as a prompt goes through routeToMain, prefix and all.
export async function routeChatMessage(
  parts,
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
    fetchImages,
    deps = {},
  },
) {
  const text = chatPartsText(parts);
  if (isChatCommand(text)) {
    return chatCommand(text, { channel, settings, run, wait, now, log, setEnabled, channelFor });
  }
  if (!enabled) {
    log(`chat · refused · oncall is off · ${channel.name}`);
    await channel.reply(OFF_NOTICE);
    return { skipped: "off" };
  }
  // Asked before the images are fetched: this message goes nowhere.
  const testPing = aboutTestPing(quotedId, { toLatest: !bareToMain(settings), now });
  if (testPing) {
    return answerTestPing(channel, TEST_PING_NOTICE[testPing], log);
  }
  const ready = await readyChatParts(parts, { fetchImages, channel });
  if (!ready) {
    return { skipped: "nothing-to-send" };
  }
  let mainPane;
  const isMain = (paneId) => {
    mainPane ??= lookupAgentByName(settings.mainAgentName, run).paneId ?? null;
    return Boolean(paneId) && paneId === mainPane;
  };
  const hit = lookupOutbound(quotedId, now);
  if (hit) {
    if (hit.status !== "blocked" && isMain(hit.paneId)) {
      return routeToMain(ready, { channel, messageId, settings, run, now, log });
    }
    return finishDelivery({ ...hit, explicit: true }, ready, { ...deps, run, wait, channel });
  }
  if (bareToMain(settings)) {
    return routeToMain(ready, { channel, messageId, settings, run, now, log });
  }
  const latest = lastOutbound(now);
  if (!latest?.paneId) {
    await channel.reply(NO_TARGET);
    return { skipped: "no-target" };
  }
  if (latest.status !== "blocked" && isMain(latest.paneId)) {
    return routeToMain(ready, { channel, messageId, settings, run, now, log });
  }
  return finishDelivery({ ...latest, explicit: false }, ready, { ...deps, run, wait, channel });
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
