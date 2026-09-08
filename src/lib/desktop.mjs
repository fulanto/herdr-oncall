import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { envFlag } from "./config.mjs";
import { stateDir } from "./paths.mjs";
import { blockedDelayMs } from "./gate.mjs";

export const PANEL_BINARY = "oncall-panel";

export function panelBinaryPath() {
  return join(stateDir(), PANEL_BINARY);
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
  return options.map((option) => `${option.key}. ${option.label}`.slice(0, 80));
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

export function showPanel({ paneId, title, where, body, options = [], timeoutMs = panelTimeoutMs() }) {
  const binary = panelBinaryPath();
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const guard = setTimeout(() => child.kill("SIGTERM"), timeoutMs + 10_000);
    child.on("error", (error) => {
      clearTimeout(guard);
      if (paneId) {
        forgetPanel(paneId, child.pid);
      }
      console.error(`panel failed: ${error.message}`);
      resolve({ kind: "unavailable" });
    });
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      if (paneId) {
        forgetPanel(paneId, child.pid);
      }
      if (signal) {
        resolve({ kind: "superseded" });
        return;
      }
      if (code !== 0) {
        console.error(`panel exited: ${stderr.trim() || `exit ${code}`}`);
        resolve({ kind: "unavailable" });
        return;
      }
      resolve(parsePanelResult(stdout));
    });
  });
}
