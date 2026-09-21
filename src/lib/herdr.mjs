import { runHerdr, sleep } from "./paths.mjs";

export function extractAgentStatus(payload) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    const candidates = [
      root.agent_status,
      root.agent?.state,
      root.agent?.status,
      root.pane?.agent_status,
      root.pane?.agent?.state,
      root.status,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim().toLowerCase();
      }
    }
  }
  return undefined;
}

export function currentPaneStatus(paneId, run = runHerdr) {
  if (!paneId) {
    return undefined;
  }
  const result = run(["pane", "get", paneId]);
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    return undefined;
  }
  try {
    return extractAgentStatus(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export function stillBlocked(paneId, run = runHerdr) {
  const status = currentPaneStatus(paneId, run);
  if (!status) {
    return true;
  }
  return status === "blocked";
}

// Herdr 0.9.0 lets an integration own an agent's lifecycle (Pi, OMP, Kimi Code,
// OpenCode, Kilo, MastraCode): the state comes from a hook, not from screen
// text, and `screen_detection_skipped` says so. Undefined on older Herdr or
// when the call fails — the caller must not read that as false.
export function extractDetectionSkipped(payload) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    const candidates = [
      root.screen_detection_skipped,
      root.agent?.screen_detection_skipped,
      root.pane?.screen_detection_skipped,
      root.pane?.agent?.screen_detection_skipped,
    ];
    for (const value of candidates) {
      if (typeof value === "boolean") {
        return value;
      }
    }
  }
  return undefined;
}

function agentListEntry(payload, paneId) {
  const roots = [payload?.result, payload?.result?.data, payload?.data, payload].filter(Boolean);
  for (const root of roots) {
    const lists = [root, root.agents, root.items, root.list];
    for (const list of lists) {
      if (!Array.isArray(list)) {
        continue;
      }
      const hit = list.find(
        (item) => String(item?.pane_id ?? item?.paneId ?? "") === String(paneId),
      );
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

export function agentDetectionSkipped(paneId, run = runHerdr) {
  if (!paneId) {
    return undefined;
  }
  const attempts = [
    { args: ["agent", "get", paneId, "--json"] },
    { args: ["agent", "get", paneId] },
    { args: ["agent", "list", "--json"], fromList: true },
    { args: ["agent", "list"], fromList: true },
  ];
  for (const attempt of attempts) {
    const result = run(attempt.args);
    if (result?.error || result?.status !== 0 || !result?.stdout?.trim()) {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      continue;
    }
    const value = attempt.fromList
      ? extractDetectionSkipped(agentListEntry(payload, paneId))
      : extractDetectionSkipped(payload);
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

// Is this pane really waiting on a human? The screen is the primary witness,
// but an agent whose lifecycle a hook owns can be genuinely blocked with no
// menu drawn at all, and then Herdr's own status is the only witness there is.
// Pure so the hook's decision is testable without spawning anything.
export function decideBlockedReal({
  screenReadable = true,
  screenLive,
  detectionSkipped,
  stillBlocked: blocked,
}) {
  if (!screenReadable) {
    // After a few seconds of retries a blank pane is a redraw or a dead pane,
    // never a question — and Herdr's own `blocked` can outlive either. An empty
    // panel and an empty ping are useless, so a blank screen is never evidence.
    return false;
  }
  if (screenLive) {
    return "screen";
  }
  if (detectionSkipped === true && blocked) {
    return "hook-authoritative";
  }
  return false;
}

export function extractPaneFocused(payload) {
  const roots = [payload?.result?.pane, payload?.result, payload?.pane, payload].filter(Boolean);
  for (const root of roots) {
    if (typeof root.focused === "boolean") {
      return root.focused;
    }
  }
  return undefined;
}

// True when this pane is the focused pane of the focused workspace in Herdr.
// Undefined when Herdr could not tell us.
export function paneFocused(paneId) {
  if (!paneId) {
    return undefined;
  }
  const result = runHerdr(["pane", "get", paneId]);
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    return undefined;
  }
  try {
    return extractPaneFocused(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export function extractReadText(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  const nested =
    payload?.result?.read?.text ?? payload?.read?.text ?? payload?.result?.data?.read?.text;
  if (typeof nested === "string" && nested.trim()) {
    return nested;
  }
  const roots = [payload?.result, payload?.result?.data, payload].filter(Boolean);
  for (const root of roots) {
    if (typeof root === "string") {
      return root;
    }
    for (const key of ["content", "text", "output", "screen", "value"]) {
      if (typeof root[key] === "string") {
        return root[key];
      }
    }
    if (Array.isArray(root.lines)) {
      return root.lines.map((line) => (typeof line === "string" ? line : line?.text ?? "")).join("\n");
    }
  }
  return "";
}

export function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function readPaneScreen(paneId, options = {}, run = runHerdr) {
  if (!paneId) {
    return "";
  }
  const recent = Boolean(options.recent);
  const attempts = recent
    ? [
        ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "120", "--format", "text"],
        ["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "120", "--format", "text"],
        ["pane", "read", paneId, "--source", "recent", "--lines", "120", "--format", "text"],
        ["pane", "read", paneId, "--source", "visible", "--format", "text"],
      ]
    : [
        ["pane", "read", paneId, "--source", "visible", "--format", "text"],
        ["pane", "read", paneId, "--source", "detection"],
        ["agent", "read", paneId, "--source", "visible", "--format", "text"],
      ];
  for (const args of attempts) {
    const result = run(args);
    if (result.error || result.status !== 0 || !result.stdout?.trim()) {
      continue;
    }
    try {
      const text = stripAnsi(extractReadText(JSON.parse(result.stdout))).trim();
      if (text) {
        return text;
      }
    } catch {
      const text = stripAnsi(result.stdout).trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

// One blank read means nothing: Codex clears and redraws the pane the moment a
// dialog is answered, and Herdr can emit `blocked` into that gap. Keep asking
// for a few seconds, and only then believe the emptiness. Returns the last
// value read, so the caller still sees "" when the pane really is empty.
//
// `ready` is what counts as settled. Blank is the default and is all `blocked`
// needs, since its own gate re-checks the screen afterwards. A `done` read can
// come back non-blank and still be mid-redraw — the prompt box and the mode
// footer are drawn before the turn above them — so that caller waits for a read
// it can actually report instead.
export async function readScreenSettled(
  read,
  { attempts = 6, delayMs = 500, sleep: wait = sleep, ready } = {},
) {
  const settled = ready ?? ((text) => Boolean(String(text).trim()));
  let text = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    text = (await read()) ?? "";
    if (settled(text)) {
      return text;
    }
    if (attempt < attempts - 1) {
      await wait(delayMs);
    }
  }
  return text;
}
