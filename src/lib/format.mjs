import { createHash } from "node:crypto";
import { basename } from "node:path";
import { stripAnsi } from "./herdr.mjs";
import { sleep } from "./paths.mjs";
import { worktreeFrom, worktreeLabel, worktreeShortName } from "./worktree.mjs";

// Answering one question of a multi-question form does not end the pane's wait:
// the form advances to its next tab in place, the status never leaves `blocked`,
// and so Herdr fires no event at all. A hook that exits after delivering its
// answer takes the panel with it and leaves the rest of the form to the
// terminal. Poll for the question that replaces the one just answered.
//
// The screen decides, not the status: Herdr's detection lags a redraw, and a
// pane it briefly calls `working` can already have the next question drawn.
export async function nextDialog({
  read,
  status,
  answered,
  attempts = 16,
  delayMs = 500,
  wait = sleep,
}) {
  for (let i = 0; i < attempts; i++) {
    await wait(delayMs);
    const screen = await read();
    if (String(screen ?? "").trim() && screenHasLiveDialog(screen)) {
      const fingerprint = dialogFingerprint(screen);
      if (fingerprint && fingerprint !== answered) {
        return { screen, fingerprint };
      }
      // The same question is still on screen; the redraw has not landed yet.
      continue;
    }
    const live = status?.();
    if (live && live !== "blocked") {
      return undefined;
    }
  }
  return undefined;
}

export function paneIdFrom(event, context) {
  const raw =
    event?.data?.pane_id ??
    event?.pane_id ??
    context.pane_id ??
    context.focused_pane_id ??
    "";
  return String(raw);
}

export function blockedSnippet(screen, limit = 24) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  const slice = region
    ? lines.slice(region.start, region.end)
    : lines.filter((line) => !isBlank(line)).slice(-limit);
  return capSnippet(renderBlock(slice));
}

// Is a dialog actually waiting on this screen, as opposed to one an agent
// merely printed earlier in the transcript?
//
// A live dialog is the last thing the terminal drew: only key hints, the
// prompt box and status lines come after it. Quoted text always has real
// content below it. Herdr's own detector matches dialog wording anywhere in
// the recent buffer, so a pane can be reported `blocked` purely because the
// agent discussed a permission prompt — this is the check that tells the two
// apart, and it reads the pane over Herdr's socket, so it works no matter what
// is on the physical display.
export function screenHasLiveDialog(screen) {
  const lines = screenLines(screen);
  if (!lines.some((line) => !isBlank(line))) {
    return false;
  }
  const region = dialogRegion(lines);
  if (!region) {
    return false;
  }
  for (let i = region.end; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isRuleLine(line) || isChromeLine(line)) {
      continue;
    }
    return false;
  }
  return true;
}

// A menu waiting on a keypress right now, as opposed to a numbered list the
// agent ended its turn with. `screenHasLiveDialog` cannot tell those two apart:
// a turn that closes on "1. … 2. …" is followed by nothing but the empty prompt
// box and its footer, which is exactly what sits under a real dialog. What a
// list in prose never has is the selection cursor — a menu draws `❯`/`›` on the
// choice Enter would take. It also takes two choices to make a menu, which
// keeps a draft typed into the prompt box ("❯ 1. first…") out of it.
//
// This is the check that overrules Herdr when it misses a question: Claude
// Code's multi-question form has been reported `done`, and then `idle`, with
// the form still up and waiting.
export function screenHasOpenMenu(screen) {
  if (!screenHasLiveDialog(screen)) {
    return false;
  }
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  if (region?.optionStart === undefined) {
    return false;
  }
  const cursor = lines
    .slice(region.optionStart, region.end)
    .some((line) => /^\s*[❯›▸]\s*\d{1,2}[.)、]\s+\S/.test(line));
  return cursor && parseBlockedOptions(screen).length >= 2;
}

// The dialog as the terminal drew it: where the content being approved starts,
// where the question is, and where the options end. Boundaries come from the
// UI's own structure (turn markers, rules, paragraph breaks), never from a
// line count — the input is one viewport, so there is nothing to guard against.
export function dialogRegion(lines) {
  const options = trailingOptionRun(lines);
  const header = questionIndex(lines, options);
  if (header < 0 && !options) {
    return undefined;
  }
  const anchor = header >= 0 ? header : options.start;
  return {
    start: dialogStartIndex(lines, anchor, options),
    header: anchor,
    optionStart: options?.start,
    end: options ? options.end : dialogEndIndex(lines, anchor),
  };
}

// The choices are always the last thing a dialog draws: the run of numbered
// lines at the bottom of the screen, below any prose and above the key hints.
// Numbered lines higher up belong to the description or to earlier chat, and
// taking the first run instead of this one is what once put a workflow's phase
// list on the buttons.
function trailingOptionRun(lines) {
  let bottom = -1;
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (isBlank(line) || isRuleLine(line) || isChromeLine(line)) {
      continue;
    }
    // The last choice's own wrapped tail sits below it, so it is the first
    // thing this scan meets. It is part of the run, not the end of it: stepping
    // over it keeps the run findable, and stretching `end` past it keeps the
    // tail in the region, where `joinWrappedOptions` puts it back on the label.
    if (isKeyParenthetical(line)) {
      if (end < 0) {
        end = i + 1;
      }
      continue;
    }
    if (isOptionLine(line)) {
      bottom = i;
      if (end < 0) {
        end = i + 1;
      }
    }
    break;
  }
  if (bottom < 0) {
    return undefined;
  }
  // A wrapped option continues on a more indented line; anything at or left of
  // the option column ends the run.
  const column = indentOf(lines[bottom]);
  let top = bottom;
  let lowest = optionNumber(lines[bottom]);
  for (let i = bottom - 1; i >= 0; i--) {
    const line = lines[i];
    if (isOptionLine(line)) {
      top = i;
      lowest = optionNumber(line) ?? lowest;
      continue;
    }
    // A multi-question form draws a rule *inside* its choice list — Claude
    // Code's tabbed form puts "Chat about this" in its own section under the
    // divider. Cross it only when the line above continues the numbering
    // downward, so an unrelated list further up is still never pulled in.
    if (isRuleLine(line)) {
      const above = lines[i - 1];
      if (above !== undefined && isOptionLine(above) && optionNumber(above) === lowest - 1) {
        continue;
      }
      break;
    }
    if (isBlank(line) || isChromeLine(line) || isTurnMarker(line)) {
      break;
    }
    if (indentOf(line) > column) {
      top = i;
      continue;
    }
    break;
  }
  return { start: top, end };
}

function optionNumber(line) {
  const match = cleanOptionLine(line).match(/^(\d{1,2})[.)、]\s+\S/);
  return match ? Number(match[1]) : undefined;
}

// The question owning those choices: the nearest line above them that ends in a
// question mark. It stops at the same structural boundaries as the body walk,
// so a question from an earlier turn cannot be picked up.
function questionIndex(lines, options) {
  if (options) {
    let blanks = 0;
    for (let i = options.start - 1; i >= 0; i--) {
      const line = lines[i];
      if (isBlank(line)) {
        if (++blanks >= 2) {
          break;
        }
        continue;
      }
      blanks = 0;
      if (isUserMarker(line) || isRuleLine(line)) {
        break;
      }
      // Fullwidth `？` ends a question written in Chinese or Japanese just as
      // `?` ends an English one; matching only the ASCII form left a real
      // question unfound and the snippet with nothing but its choices.
      if (/[?？]\s*$/.test(line)) {
        return i;
      }
      if (isTurnMarker(line)) {
        break;
      }
    }
  }
  return keywordHeaderIndex(lines);
}

// No numbered choices on screen (a bare y/n prompt): name the question by its
// wording instead. Prefer the last match so earlier prose that merely mentions
// permissions does not win.
function keywordHeaderIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(would you like|do you want|allow|permission)[^?？]*[?？]/i.test(lines[i])) {
      return i;
    }
  }
  return lines.findIndex(
    (line) =>
      /would you like|do you want|allow |permission|environment:/i.test(line) || /^\s*\$ /.test(line),
  );
}

function indentOf(line) {
  return String(line).match(/^\s*/)[0].length;
}

// The content being approved sits above the question only when the options
// follow it with nothing in between. When lines separate the two — Codex
// printing "Environment:" and the command under the question — the content is
// below and the question is the start. Otherwise walk up to the first
// structural boundary: the turn marker or tool header that owns this block,
// the previous user turn, a drawn rule, or a paragraph break.
function dialogStartIndex(lines, header, options) {
  if (!options || hasContentBetween(lines, header, options.start)) {
    return header;
  }
  let start = header;
  let blanks = 0;
  while (start > 0) {
    const prev = lines[start - 1];
    if (isBlank(prev)) {
      if (++blanks >= 2) {
        break;
      }
      start--;
      continue;
    }
    blanks = 0;
    if (isUserMarker(prev) || isRuleLine(prev)) {
      break;
    }
    start--;
    if (isTurnMarker(prev) || isToolHeaderLine(prev)) {
      break;
    }
  }
  return start;
}

function hasContentBetween(lines, from, to) {
  for (let i = from + 1; i < to; i++) {
    if (!isBlank(lines[i]) && !isRuleLine(lines[i])) {
      return true;
    }
  }
  return false;
}

// "⏺ Bash(...)" in Claude Code, "● Edit" in others: the line that owns the
// block below it.
function isTurnMarker(line) {
  return /^\s{0,4}[⏺●⚫]\s+\S/.test(line);
}

// Codex names the tool on its own header line instead of using a marker glyph.
function isToolHeaderLine(line) {
  const text = line.trim();
  return /^(bash|shell|local shell|read|write|edit|update|multi-?edit|apply.?patch|web.?fetch|web.?search|task|glob|grep)\b.{0,60}$/i.test(
    text,
  );
}

function isOptionLine(line) {
  return /^\s*[❯›▸>]?\s*\d{1,2}[.)、]\s+\S/.test(cleanOptionLine(line));
}

// A line that is nothing but a key name in parentheses — "(shift+tab)", "(esc)"
// — is the tail of the option above it, wrapped by the terminal past the pane
// width, and never a footer. Claude Code draws "2. Yes, and always allow access
// to /Users/… for this session (shift+tab)" and breaks it exactly there; while
// `shift+tab` counted as a key hint, the walk up the choice list stopped dead
// at the tail and the panel opened with one button ("3. No") while the other
// two choices sat stranded in the body. A real key hint says what the key
// *does* ("shift+tab to cycle", "esc to interrupt"), and the space that takes
// is what tells the two apart.
function isKeyParenthetical(line) {
  return /^\(\s*[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*\s*\)$/.test(String(line).trim());
}

// Stop before the spinner, prompt box, or status line that the visible screen
// carries below a dialog with no numbered options.
function dialogEndIndex(lines, header) {
  let blanks = 0;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      if (++blanks >= 2) {
        return i;
      }
      continue;
    }
    blanks = 0;
    if (isChromeLine(line) || isUserMarker(line) || isTurnMarker(line)) {
      return i;
    }
  }
  return lines.length;
}

// Drop the drawn borders, trim the edges, and collapse blank runs so the block
// reads the same in Telegram and in the panel.
function renderBlock(slice) {
  const kept = slice.filter((line) => !isRuleLine(line));
  const out = [];
  for (const line of kept) {
    if (isBlank(line)) {
      if (out.length && !isBlank(out.at(-1))) {
        out.push("");
      }
      continue;
    }
    out.push(line);
  }
  while (out.length && isBlank(out.at(-1))) {
    out.pop();
  }
  return out.join("\n").trim();
}

export function doneSnippet(screen, limit = 40) {
  const lines = screenLines(screen).filter((line) => !isChromeLine(line) && !isRuleLine(line));
  if (!lines.length) {
    return "";
  }
  let userIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isUserMarker(lines[i])) {
      userIdx = i;
    }
  }
  let body = trimBodyTail(userIdx >= 0 ? lines.slice(userIdx + 1) : []);
  // Nothing left under that "user turn" means it was the prompt box, not a
  // message: Claude Code draws the box as "❯ <whatever is typed>", which reads
  // exactly like a turn the user sent, and below it there is only chrome. Fall
  // back to the tail so the ping carries the agent's answer rather than
  // whatever survived underneath the box.
  if (!body.length) {
    body = trimBodyTail(lines.slice(-limit));
  }
  if (body.length > limit) {
    body = body.slice(-limit);
  }
  return capSnippet(body.join("\n").trim());
}

function trimBodyTail(body) {
  const out = [...body];
  while (out.length && (isUserMarker(out.at(-1)) || isChromeLine(out.at(-1)))) {
    out.pop();
  }
  return out;
}

// Lines as the terminal drew them. Blank lines and drawn rules are kept: they
// are the boundaries between blocks, and dropping them is what forces guesswork
// like "take the last N lines". Consumers filter what they do not want.
function screenLines(screen) {
  return stripAnsi(screen)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
}

function isBlank(line) {
  return !String(line).trim();
}

// A drawn border or separator: "\u2500\u2500\u2500\u2500", "\u256D\u2500\u2500\u256E", and the labelled kind the
// agents draw across the width of the pane \u2014 "\u2500\u2500\u2500\u2500 ultracode \u21AF \u2500" \u2014 where a
// short caption sits inside a long run of box-drawing characters.
function isRuleLine(line) {
  const text = String(line).trim();
  if (text.length < 3) {
    return false;
  }
  if (/^[\u2500-\u257F\u2580-\u259F\s]+$/.test(text)) {
    return true;
  }
  const box = (text.match(/[\u2500-\u257F\u2580-\u259F]/g) || []).length;
  return box >= 8 && box / text.length >= 0.5;
}

function isChromeLine(line) {
  const text = line.trim();
  if (!text) {
    return true;
  }
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷•·●○]+$/.test(text)) {
    return true;
  }
  if (/^(idle|done|finished|working|blocked|thinking|ready)\b/i.test(text) && text.length < 24) {
    return true;
  }
  // A line that is nothing but a bare key name in parentheses is the tail of
  // the option above it, wrapped by the terminal — never a footer. See
  // `isKeyParenthetical`.
  if (isKeyParenthetical(text)) {
    return false;
  }
  // Key hints and the spinner footer. `tokens` must carry its count: the bare
  // word matched any short line that merely mentioned one, and an option whose
  // description read "任何人可从 ai-assistant 取到 ASR token" was read as a
  // footer — the walk up the choice list stopped dead there and the ping went
  // out with the first two options missing.
  if (
    /(\b\d+(?:\.\d+)?k?\s*tokens?\b|\bcontext window\b|\besc to \b|\bpress (enter|esc)\b|\bctrl\+|\binterrupt\b|\bshift\+tab\b)/i.test(
      text,
    ) &&
    text.length < 96
  ) {
    return true;
  }
  // Status footers the agents draw under everything else: Claude Code's
  // "➜ repo git:(main) ctx:33% Opus 5", Codex's "» Ask Codex to do anything".
  if (/\bctx:\d+%/.test(text) || /^»\s/.test(text)) {
    return true;
  }
  // Claude Code's task list, drawn under the prompt box and so *below* a live
  // dialog: a "4 tasks (3 done, 1 in progress, 0 open)" summary and one
  // glyph-led row per task. Counting those rows as content is what made a real
  // permission prompt read as one merely quoted in the transcript — the panel
  // stopped opening for any pane with a todo list, and the options went missing
  // with it, since the choice run is found by walking up past the chrome.
  if (/^\d+\s+tasks?\s*\(/i.test(text)) {
    return true;
  }
  if (/^[✔✓☑◼◻☐■□▪▫]\s+\S/.test(text)) {
    return true;
  }
  // Claude Code's permission-mode footer, drawn under the prompt box. It reads
  // "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents" on a bare pane but
  // "⏵⏵ accept edits on · 1 monitor · ← 1 agent" once monitors or agents are
  // attached — no key hint, no token count, nothing else here matched it. So it
  // counted as content, and a done ping went out with the footer as its whole
  // body. The `⏵⏵` marker is the footer, whatever it goes on to say.
  if (/^⏵{1,2}\s/.test(text)) {
    return true;
  }
  if (/^[❯›▸$]\s*$/.test(text) || /^codex>\s*$/i.test(text)) {
    return true;
  }
  return false;
}

function isUserMarker(line) {
  const text = line.trim();
  if (/^(you|user|human)\s*[:：]/i.test(text)) {
    return true;
  }
  if (/^[❯›▸]\s+\S/.test(text)) {
    return true;
  }
  return false;
}

function capSnippet(text) {
  if (text.length <= 3200) {
    return text;
  }
  let slice = text.slice(-3200);
  const nl = slice.indexOf("\n");
  if (nl > 0 && nl < 200) {
    slice = slice.slice(nl + 1);
  }
  return slice.trim();
}

function cleanOptionLine(raw) {
  return stripAnsi(raw)
    .replace(/[\u2500-\u257F]/g, " ")
    .replace(/^[^\w\d(]*?(?=\d{1,2}[.)、])/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Put an option back together after the terminal wrapped it. A long choice is
// set across two lines with a hanging indent — "…for this session" and then
// "(shift+tab)" alone underneath — and reading only the numbered line drops
// whatever landed on the tail. Joining is also what makes the wrapped form
// behave like the inline one: the trailing parenthetical is weighed as a
// shortcut, or kept as prose, on the same terms either way, and the label stops
// changing when the pane is resized and the wrap moves. Only the agent's own
// hanging indent gets here — a hard wrap at column 0 is left of the option
// column, so `trailingOptionRun` never admits it — which is why the pieces join
// on a word boundary with a single space.
function joinWrappedOptions(lines) {
  const rows = [];
  for (const raw of lines) {
    // A form draws a divider between two sections of its choice list. Rules
    // survive `cleanOptionLine` when they carry a caption, and gluing one onto
    // the option above it would put the caption on a button.
    if (isRuleLine(raw)) {
      continue;
    }
    const line = cleanOptionLine(raw);
    if (!line) {
      continue;
    }
    if (/^\d{1,2}[.)、]\s+\S/.test(line)) {
      rows.push(line);
    } else if (rows.length) {
      rows[rows.length - 1] += ` ${line}`;
    }
  }
  return rows;
}

export function parseBlockedOptions(screen) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  // Only the choices under this question. Numbered lines elsewhere on screen
  // are earlier chat messages, not options.
  const candidates =
    region?.optionStart === undefined ? [] : lines.slice(region.optionStart, region.end);
  const options = [];
  const seen = new Set();
  for (const line of joinWrappedOptions(candidates)) {
    const numbered = line.match(/^(\d{1,2})[.)、]\s+(.+)$/);
    if (!numbered) {
      continue;
    }
    const index = numbered[1];
    let rest = numbered[2].replace(/\s+/g, " ").trim();
    let shortcut;
    const trailing = rest.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (trailing) {
      shortcut = normalizeShortcut(trailing[2]);
      // Only a real keystroke is stripped from the label. "(default)" and
      // "(shift+tab)" are prose the user should still read, and typing them
      // into the pane is what a stripped non-shortcut used to do.
      if (shortcut) {
        rest = trailing[1].trim();
      }
    }
    const send = shortcut || index;
    if (seen.has(send) || seen.has(`i:${index}`)) {
      continue;
    }
    seen.add(send);
    seen.add(`i:${index}`);
    // Bounded by the widest thing that renders a label: the desktop panel, at
    // 96 for "<key>. <label>" (`panelLabels`). Telegram caps its own button at
    // 64. The old 72 predated rejoining wrapped options and cut a real choice
    // mid-word — "…for this sessio" — as soon as the tail was added back.
    options.push({ key: index, send, label: rest.slice(0, 96) });
  }
  if (options.length) {
    return options.slice(0, 9);
  }
  if (/\b\[?y\/n\]?\b/i.test(screen) || /\(y\/n\)/i.test(screen)) {
    return [
      { key: "y", send: "y", label: "yes" },
      { key: "n", send: "n", label: "no" },
    ];
  }
  return [];
}

// The one gate for every set of buttons we offer, Telegram and desktop panel
// alike. A hook-authoritative block has no menu drawn at all, so the y/n
// fallback above would happily put buttons on an agent that is waiting for free
// text — and a tap would send a keystroke it never asked for.
export function dialogChoices(screen, { hookAuthoritative = false } = {}) {
  return hookAuthoritative ? [] : parseBlockedOptions(screen);
}

// A trailing parenthetical is a keystroke only when it names one. The old
// "alphanumeric and short" rule turned "1. Yes (default)" into the key
// sequence "default", which the reply path types into the pane as text.
const NAMED_SHORTCUTS = {
  esc: "esc",
  escape: "esc",
  enter: "enter",
  return: "enter",
  tab: "tab",
  space: "space",
};

function normalizeShortcut(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase();
  if (!text) {
    return undefined;
  }
  if (NAMED_SHORTCUTS[text]) {
    return NAMED_SHORTCUTS[text];
  }
  if (/^[a-z0-9]$/.test(text)) {
    return text;
  }
  return undefined;
}

// What this dialog is asking, condensed to a stable id: the question plus the
// choices, nothing else. The inbound path compares it against the live screen
// before pressing a key, so a button tapped minutes late cannot answer whatever
// dialog happens to be up now. Spinners and footers sit outside the region, so
// two reads of an unchanged dialog hash the same.
export function dialogFingerprint(screen) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  if (!region) {
    return undefined;
  }
  const parts = [collapse(region.header >= 0 ? lines[region.header] : "")];
  for (const option of parseBlockedOptions(screen)) {
    parts.push(`${option.key}|${collapse(option.label)}`);
  }
  // The body too, but only down to the first option: two Bash approvals in a
  // row ask the identical question with the identical choices, and only the
  // command tells "delete the draft" from "force-push to main". The option
  // lines themselves are already hashed as `key|label`, and re-hashing them raw
  // would move the fingerprint every time the terminal's selection marker does.
  parts.push(collapse(renderBlock(lines.slice(region.start, region.optionStart ?? region.end))));
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function collapse(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function optionKeyboard(options) {
  if (!options?.length) {
    return undefined;
  }
  return {
    inline_keyboard: options.map((option) => [
      {
        text: `${option.key}. ${option.label}`.slice(0, 64),
        callback_data: String(option.send || option.key).slice(0, 32),
      },
    ]),
  };
}

export function formatMessage(context, event, status, snippet) {
  const head = statusTitle(context, event, status);
  const where = formatWhere(context, event);
  if (status === "blocked") {
    const body = snippet || "waiting for input";
    return [head, where, "", body, "", "tap a button, or type another answer"].join("\n");
  }
  if (status === "done" || status === "finish") {
    return [head, where, "", snippet || "finished"].join("\n");
  }
  return [head, where, "", status].join("\n");
}

export function statusTitle(context = {}, event = {}, status = "") {
  return `${status} · ${agentLabel(context, event)}`;
}

export function formatWhere(context = {}, event = {}) {
  const repo = repoName(context, event);
  const worktree = worktreeFrom(context, event);
  const worktreeText = worktreeLabel(worktree);
  const worktreeShort = worktreeShortName(worktree);
  const space = spaceName(context, event);
  const tab = namedTabLabel(context.tab_label ?? event?.data?.tab_label);
  const pane = paneOrdinal(paneIdFrom(event, context));
  const parts = [];
  if (repo) {
    parts.push(repo);
  }
  if (worktreeText) {
    parts.push(worktreeText);
  }
  if (space && !equalsFold(space, repo) && !equalsFold(space, worktreeShort)) {
    parts.push(space);
  }
  if (tab) {
    parts.push(tab);
  }
  if (pane) {
    parts.push(`pane ${pane}`);
  }
  return parts.join(" · ") || paneIdFrom(event, context) || "workspace";
}

function repoName(context, event) {
  const worktree = context.worktree ?? event?.data?.worktree ?? {};
  return firstString(
    worktree.repo_name,
    worktree.repoName,
    pathBasename(worktree.repo_root),
    pathBasename(worktree.checkout_path),
  );
}

function spaceName(context, event) {
  const id = firstString(context.workspace_id, event?.data?.workspace_id);
  const label = firstString(
    context.workspace_label,
    event?.data?.workspace_label,
    event?.data?.workspace_name,
  );
  if (label && label !== id && !isOpaqueWorkspaceId(label)) {
    return label;
  }
  const cwd = firstString(
    context.workspace_cwd,
    context.focused_pane_cwd,
    event?.data?.cwd,
    event?.data?.workspace_cwd,
  );
  const fromCwd = pathBasename(cwd);
  if (fromCwd && fromCwd !== id && !isOpaqueWorkspaceId(fromCwd)) {
    return fromCwd;
  }
  if (label && !isOpaqueWorkspaceId(label)) {
    return label;
  }
  return undefined;
}

function paneOrdinal(paneId) {
  const match = String(paneId).match(/:p([0-9A-Za-z]+)$/i);
  return match ? match[1] : undefined;
}

function isOpaqueWorkspaceId(text) {
  return /^w[0-9A-Za-z]{1,3}$/.test(String(text));
}

function pathBasename(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const name = basename(value.trim().replace(/[\\/]+$/, ""));
  return name && name !== "." && name !== ".git" ? name : undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function equalsFold(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function agentLabel(context, event) {
  const raw =
    event?.data?.display_agent ??
    event?.data?.agent ??
    context.focused_pane_agent ??
    context.agent ??
    "agent";
  return titleCase(raw);
}

function namedTabLabel(label) {
  const text = String(label ?? "").trim();
  if (!text || /^\d+$/.test(text)) {
    return undefined;
  }
  return text;
}

function titleCase(value) {
  const text = String(value).trim();
  if (!text) {
    return "Agent";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
