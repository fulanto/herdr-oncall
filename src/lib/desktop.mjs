import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { envFlag } from "./config.mjs";
import { pluginRoot, stateDir } from "./paths.mjs";
import { blockedDelayMs } from "./gate.mjs";
import { paneFocused } from "./herdr.mjs";

export const PANEL_BINARY = "oncall-panel";

const TERMINAL_BUNDLE_PATTERN = /term|tty|ghostty|warp|kitty|alacritty|hyper|tabby|vscode|zed|cursor/i;

// Bundle id of the frontmost macOS app, via lsappinfo (no permission prompt).
export function frontmostBundleId() {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const front = spawnSync("lsappinfo", ["front"], { encoding: "utf8" });
  const asn = front.stdout?.trim();
  if (front.error || front.status !== 0 || !asn) {
    return undefined;
  }
  const info = spawnSync("lsappinfo", ["info", "-only", "bundleid", asn], { encoding: "utf8" });
  const match = info.stdout?.match(/"CFBundleIdentifier"\s*=\s*"([^"]+)"/);
  return match ? match[1] : undefined;
}

export function isTerminalBundle(bundleId, extra = process.env.DESKTOP_PANEL_TERMINALS) {
  const id = String(bundleId || "").trim();
  if (!id) {
    return false;
  }
  const extras = String(extra || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (extras.includes(id.toLowerCase())) {
    return true;
  }
  return TERMINAL_BUNDLE_PATTERN.test(id);
}

// The user is looking at this pane: it is Herdr's focused pane and a terminal
// app is frontmost. Unknown frontmost app falls back to the focus flag alone.
export function userAtPane(paneId, { focused = paneFocused, frontmost = frontmostBundleId } = {}) {
  if (focused(paneId) !== true) {
    return false;
  }
  const bundle = frontmost();
  if (!bundle) {
    return true;
  }
  return isTerminalBundle(bundle);
}

// Compiled by bin/install-deps.sh into the plugin root. Herdr's build step does
// not set HERDR_PLUGIN_STATE_DIR while events and actions do, so the state dir
// is not a stable meeting point; the plugin root is known to both.
export function panelBinaryPath() {
  return join(pluginRoot, "bin", PANEL_BINARY);
}

export function panelEnabled() {
  return process.platform === "darwin" && envFlag("DESKTOP_PANEL", true);
}

export function panelAvailable() {
  if (!panelEnabled()) {
    return false;
  }
  try {
    return statSync(panelBinaryPath()).isFile();
  } catch {
    return false;
  }
}

export function panelTimeoutMs(raw = process.env.DESKTOP_PANEL_TIMEOUT_SEC) {
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0) {
    return Math.round(sec * 1000);
  }
  return blockedDelayMs() || 60_000;
}

export function parsePanelResult(stdout) {
  const line = String(stdout ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    return { kind: "timeout" };
  }
  const button = line.match(/^button:(\d+)$/);
  if (button) {
    return { kind: "button", index: Number(button[1]) };
  }
  if (line.startsWith("text:")) {
    const text = line.slice(5).trim();
    return text ? { kind: "text", text } : { kind: "timeout" };
  }
  if (line === "dismiss") {
    return { kind: "dismiss" };
  }
  return { kind: "timeout" };
}

export function panelLabels(options = []) {
  return options.map((option) => `${option.key}. ${option.label}`.slice(0, 96));
}

function panelPidsPath() {
  return join(stateDir(), "panels.json");
}

function readPanelPids() {
  try {
    return JSON.parse(readFileSync(panelPidsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writePanelPids(store) {
  mkdirSync(dirname(panelPidsPath()), { recursive: true });
  writeFileSync(panelPidsPath(), JSON.stringify(store), "utf8");
}

export function rememberPanel(paneId, pid) {
  const store = readPanelPids();
  store[paneId] = pid;
  writePanelPids(store);
}

export function forgetPanel(paneId, pid) {
  const store = readPanelPids();
  if (pid === undefined || Number(store[paneId]) === Number(pid)) {
    delete store[paneId];
    writePanelPids(store);
  }
}

export function closePanelFor(paneId) {
  const store = readPanelPids();
  const pid = Number(store[paneId] ?? 0);
  if (pid > 1 && pid !== process.pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  delete store[paneId];
  writePanelPids(store);
}

// `until` is polled every `watchMs`; when it returns a truthy value the panel
// is closed and the result is { kind: "resolved", reason } where reason is
// that value (a string such as "moved-on" or "at-pane").
export function showPanel({
  paneId,
  title,
  where,
  body,
  options = [],
  timeoutMs = panelTimeoutMs(),
  until,
  watchMs = 2000,
  binary = panelBinaryPath(),
}) {
  if (!existsSync(binary)) {
    return Promise.resolve({ kind: "unavailable" });
  }
  if (paneId) {
    closePanelFor(paneId);
  }
  const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));
  const args = [String(timeoutSec), title, where, body || "", ...panelLabels(options)];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      console.error(`panel failed to start: ${error.message}`);
      resolve({ kind: "unavailable" });
      return;
    }
    if (paneId) {
      rememberPanel(paneId, child.pid);
    }
    let stdout = "";
    let stderr = "";
    let resolvedByWatch;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const guard = setTimeout(() => child.kill("SIGTERM"), timeoutMs + 10_000);
    const watcher =
      typeof until === "function"
        ? setInterval(() => {
            let reason;
            try {
              reason = until();
            } catch {
              reason = undefined;
            }
            if (reason && resolvedByWatch === undefined) {
              resolvedByWatch = reason === true ? "moved-on" : String(reason);
              child.kill("SIGTERM");
            }
          }, watchMs)
        : undefined;
    const cleanup = () => {
      clearTimeout(guard);
      if (watcher) {
        clearInterval(watcher);
      }
      if (paneId) {
        forgetPanel(paneId, child.pid);
      }
    };
    child.on("error", (error) => {
      cleanup();
      console.error(`panel failed: ${error.message}`);
      resolve({ kind: "unavailable" });
    });
    child.on("close", (code, signal) => {
      cleanup();
      const noise = stderr.trim();
      if (noise) {
        console.error(noise);
      }
      if (resolvedByWatch) {
        resolve({ kind: "resolved", reason: resolvedByWatch });
        return;
      }
      if (signal) {
        resolve({ kind: "superseded" });
        return;
      }
      if (code !== 0) {
        console.error(`panel exited ${code}`);
        resolve({ kind: "unavailable" });
        return;
      }
      resolve(parsePanelResult(stdout));
    });
  });
}
