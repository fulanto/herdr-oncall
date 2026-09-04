import { runHerdr } from "./paths.mjs";

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

export function currentPaneStatus(paneId) {
  if (!paneId) {
    return undefined;
  }
  const result = runHerdr(["pane", "get", paneId]);
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    return undefined;
  }
  try {
    return extractAgentStatus(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export function stillBlocked(paneId) {
  const status = currentPaneStatus(paneId);
  if (!status) {
    return true;
  }
  return status === "blocked";
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

export function readPaneScreen(paneId, options = {}) {
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
    const result = runHerdr(args);
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
