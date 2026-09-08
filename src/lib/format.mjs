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
  if (!region) {
    return capSnippet(lines.slice(Math.max(0, lines.length - limit)).join("\n").trim());
  }
  return capSnippet(lines.slice(region.start, region.end).join("\n").trim());
}

// The dialog on screen: where the content that needs approving starts, where
// the question is, and where the options end. Everything above `start` is
// earlier conversation and must not be mistaken for part of the prompt.
export function dialogRegion(lines) {
  const header = dialogHeaderIndex(lines);
  if (header < 0) {
    return undefined;
  }
  const options = optionRange(lines, header);
  return {
    start: dialogStartIndex(lines, header, options),
    header,
    optionStart: options?.start,
    end: options ? options.end : dialogEndIndex(lines, header),
  };
}

// The line that asks the question. Prefer the last question-shaped line so
// earlier prose that merely mentions "permission" does not win.
function dialogHeaderIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(would you like|do you want|allow|permission)[^?]*\?/i.test(lines[i])) {
      return i;
    }
  }
  return lines.findIndex(
    (line) =>
      /would you like|do you want|allow |permission|environment:/i.test(line) ||
      /^\s*\$ /.test(line) ||
      /^\s*[^\w]*\d{1,2}[.)]/.test(line),
  );
}

// The numbered choices belonging to this question: the first numbered line at
// or below it, then every line up to the chrome that follows. Non-numbered
// lines in between are wrapped continuations, not new options.
function optionRange(lines, header) {
  let start = -1;
  for (let i = header; i < lines.length; i++) {
    const line = lines[i];
    if (isOptionLine(line)) {
      start = i;
      break;
    }
    if (i > header && (isChromeLine(line) || isUserMarker(line))) {
      break;
    }
  }
  if (start < 0) {
    return undefined;
  }
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isChromeLine(line) || isUserMarker(line)) {
      break;
    }
    if (isOptionLine(line)) {
      end = i + 1;
    }
  }
  return { start, end };
}

// The content being approved sits above the question whenever the options come
// right after it (Claude Code, Codex "requires approval" prompts). Walk up
// through the command block to its header line; Codex's older shape puts the
// command below the question instead, and then the question is the start.
function dialogStartIndex(lines, header, options, maxAbove = 40) {
  if (!options || options.start > header + 2) {
    return header;
  }
  let start = header;
  let taken = 0;
  while (start > 0 && taken < maxAbove) {
    const prev = lines[start - 1];
    if (isChromeLine(prev) || isUserMarker(prev)) {
      break;
    }
    start--;
    taken++;
    if (isToolHeaderLine(prev)) {
      break;
    }
  }
  return start;
}

function isToolHeaderLine(line) {
  const text = stripAnsi(line).trim();
  return (
    /^[⏺●]\s+\S/.test(text) ||
    /^(bash|shell|read|write|edit|update|multiedit|web ?fetch|web ?search|task|glob|grep)\s+(command|file|tool)?\b/i.test(
      text,
    )
  );
}

function isOptionLine(line) {
  return /^\s*[❯›▸>]?\s*\d{1,2}[.)、]\s+\S/.test(cleanOptionLine(line));
}

// Stop before the spinner, prompt box, or status line that the visible screen
// carries below a dialog with no numbered options.
function dialogEndIndex(lines, header) {
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isChromeLine(line) || isUserMarker(line)) {
      return i;
    }
  }
  return lines.length;
}

export function doneSnippet(screen, limit = 40) {
  const lines = screenLines(screen).filter((line) => !isChromeLine(line));
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

function screenLines(screen) {
  return stripAnsi(screen)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim() && !/^[\u2500-\u257F]+$/.test(line.trim()));
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
