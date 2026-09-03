import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginRoot, stateDir } from "./lib.mjs";

function pidPath() {
  return join(stateDir(), "poller.pid");
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

export function startPoller() {
  const child = spawn("/bin/bash", [join(pluginRoot, "bin/run-node.sh"), "src/poll.mjs"], {
    cwd: pluginRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
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
