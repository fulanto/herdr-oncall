import { basename } from "node:path";
import { stripAnsi } from "./herdr.mjs";
import { worktreeFrom, worktreeLabel, worktreeName } from "./worktree.mjs";

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
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (isBlank(line) || isRuleLine(line) || isChromeLine(line)) {
      continue;
    }
    if (isOptionLine(line)) {
      bottom = i;
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
  for (let i = bottom - 1; i >= 0; i--) {
    const line = lines[i];
    if (isOptionLine(line)) {
      top = i;
      continue;
    }
    if (isBlank(line) || isChromeLine(line) || isRuleLine(line) || isTurnMarker(line)) {
      break;
    }
    if (indentOf(line) > column) {
      top = i;
      continue;
    }
    break;
  }
  return { start: top, end: bottom + 1 };
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
      if (/\?\s*$/.test(line)) {
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
    if (/(would you like|do you want|allow|permission)[^?]*\?/i.test(lines[i])) {
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
  let body = userIdx >= 0 && userIdx < lines.length - 1 ? lines.slice(userIdx + 1) : lines.slice(-limit);
  while (body.length && (isUserMarker(body.at(-1)) || isChromeLine(body.at(-1)))) {
    body.pop();
  }
  if (body.length > limit) {
    body = body.slice(-limit);
  }
  return capSnippet(body.join("\n").trim());
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

// A drawn border or separator: "\u2500\u2500\u2500\u2500", "\u256D\u2500\u2500\u256E", "\u2550\u2550\u2550".
function isRuleLine(line) {
  const text = String(line).trim();
  return text.length >= 3 && /^[\u2500-\u257F\u2580-\u259F\s]+$/.test(text);
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
  if (
    /\b(tokens?|context window|esc to |press (enter|esc)|ctrl\+|interrupt|shift\+tab)\b/i.test(text) &&
    text.length < 96
  ) {
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

export function parseBlockedOptions(screen) {
  const lines = screenLines(screen);
  const region = dialogRegion(lines);
  // Only the choices under this question. Numbered lines elsewhere on screen
  // are earlier chat messages, not options.
  const candidates =
    region?.optionStart === undefined ? [] : lines.slice(region.optionStart, region.end);
  const options = [];
  const seen = new Set();
  for (const raw of candidates) {
    const line = cleanOptionLine(raw);
    const numbered = line.match(/^(\d{1,2})[.)、]\s+(.+)$/);
    if (!numbered) {
      continue;
    }
    const index = numbered[1];
    let rest = numbered[2].replace(/\s+/g, " ").trim();
    let shortcut;
    const trailing = rest.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (trailing) {
      rest = trailing[1].trim();
      shortcut = normalizeShortcut(trailing[2]);
    }
    const send = shortcut || index;
    if (seen.has(send) || seen.has(`i:${index}`)) {
      continue;
    }
    seen.add(send);
    seen.add(`i:${index}`);
    options.push({ key: index, send, label: rest.slice(0, 72) });
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

function normalizeShortcut(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase();
  if (!text) {
    return undefined;
  }
  if (text === "escape") {
    return "esc";
  }
  if (text === "return") {
    return "enter";
  }
  if (/^[a-z0-9]+$/.test(text) && text.length <= 8) {
    return text;
  }
  if (text === "esc" || text === "enter" || text === "tab") {
    return text;
  }
  return undefined;
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
  const worktreeShort = worktreeName(worktree);
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
