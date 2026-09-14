import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginRoot, stateDir } from "../lib/index.mjs";

const LOG_MAX_BYTES = 256 * 1024;

function pidPath() {
  return join(stateDir(), "poller.pid");
}

export function pollerLogPath() {
  return join(stateDir(), "poller.log");
}

export function pollerPid() {
  try {
    const value = Number(readFileSync(pidPath(), "utf8").trim());
    return Number.isFinite(value) && value > 1 ? value : 0;
  } catch {
    return 0;
  }
}

export function pollerAlive(pid = pollerPid()) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePollerPid(pid = process.pid) {
  const path = pidPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`, "utf8");
}

export function stopPoller() {
  const pid = pollerPid();
  if (!pid || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

// Everything the poller prints goes to `poller.log`, and a daemon's log line is
// worth little without a time: the five-poller 409 loop that prompted this file
// ran for a day and nothing in it said when it began. Patching the console once
// in the poller process also covers reply.mjs, whose lines run inside it.
export function withTimestamps(target = console, now = () => new Date().toISOString()) {
  for (const name of ["log", "error"]) {
    const write = target[name].bind(target);
    target[name] = (...args) => write(now(), ...args);
  }
  return target;
}

// Node reports every network failure as the same three words, "fetch failed",
// and puts the reason in `cause` — sometimes a chain of them. A log line that
// cannot tell a DNS outage from a refused connection is barely worth writing.
export function describeError(error, limit = 4) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current !== undefined && current !== null && parts.length < limit && !seen.has(current)) {
    if (typeof current === "object") {
      seen.add(current);
    }
    const text = typeof current === "string" ? current : current.message || String(current);
    const code = typeof current === "object" && current.code ? ` (${current.code})` : "";
    const part = `${text}${code}`.trim();
    if (part && parts.at(-1) !== part) {
      parts.push(part);
    }
    current = typeof current === "object" ? current.cause : undefined;
  }
  return parts.join(" · ") || "unknown error";
}

// One rotation: a crash loop must not fill the disk, and the tail of the run
// that died is exactly what you want to read after the restart.
export function rotatePollerLog(path = pollerLogPath(), maxBytes = LOG_MAX_BYTES) {
  try {
    if (statSync(path).size < maxBytes) {
      return false;
    }
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    // No log yet, or a filesystem that refused the rename. Either way the
    // poller still has to start.
    return false;
  }
}

function openPollerLog() {
  try {
    mkdirSync(stateDir(), { recursive: true });
    rotatePollerLog();
    return openSync(pollerLogPath(), "a");
  } catch (error) {
    console.error(`poller log unavailable: ${error.message}`);
    return undefined;
  }
}

export function startPoller() {
  const log = openPollerLog();
  const child = spawn("/bin/bash", [join(pluginRoot, "bin/run-node.sh"), "src/hooks/poll.mjs"], {
    cwd: pluginRoot,
    detached: true,
    stdio: log === undefined ? "ignore" : ["ignore", log, log],
    env: { ...process.env },
  });
  if (log !== undefined) {
    // The child holds its own duplicate; leaving this one open would pin the
    // file in every hook process that ever started a poller.
    closeSync(log);
  }
  writePollerPid(child.pid);
  child.unref();
  return child.pid;
}

export function restartPoller() {
  stopPoller();
  return startPoller();
}

export function ensurePoller() {
  if (pollerAlive()) {
    return pollerPid();
  }
  return startPoller();
}
