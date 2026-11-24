import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dropPaneState,
  herdrSocket,
  ownership,
  pluginRoot,
  readOwner,
  socketPath,
  startupEnv,
  stateDir,
  tryLock,
  unlock,
  writeFileAtomic,
} from "../lib/index.mjs";

const LOG_MAX_BYTES = 256 * 1024;
// Starting a poller is a stop, two file writes and a spawn; a lock older than
// this was left by a process that died in the middle.
const START_LOCK_STALE_MS = 15_000;
// How long an explicit restart waits for its turn. Longer than the lock can
// stay abandoned, so a wait that runs out means a live process really held the
// lock all that time.
const START_LOCK_WAIT_MS = 20_000;
// A poller told to stop is gone in milliseconds; one that is not gets killed.
const STOP_WAIT_MS = 3000;
// How often a running poller checks that it is still the one on record, for
// the session that owns Oncall (pollerSuperseded).
export const POLLER_SELF_CHECK_MS = 5000;

// These are one-shot scripts stopping and starting a process; a pause between
// two looks at a pid or a lock does not need an event loop.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidPath() {
  return join(stateDir(), "poller.pid");
}

function bindingPath() {
  return join(stateDir(), "poller.json");
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

// The pid file and the binding below are each written twice for every start:
// by whoever started the poller, and again by the poller as it comes up. Any
// hook, `status`, or another poller's self-check can read them in between, so
// each write puts a whole file in place (writeFileAtomic). Written in place,
// a read that landed in the poller's own write found the pid file empty, which
// reads as "no poller".
export function writePollerPid(pid = process.pid) {
  writeFileAtomic(pidPath(), `${pid}\n`);
}

// Which herdr server the poller talks to: `<state>/poller.json`,
// { pid, socket }. Written by whoever starts a poller, and again by the poller
// itself from the environment it really runs with. `poller.pid` keeps its
// one-line format, since a poller started by an older version is stopped by
// it; this record only counts for the pid it names, so one left by a poller
// that is gone reads as no record.
export function writePollerBinding({ pid = process.pid, socket }) {
  writeFileAtomic(bindingPath(), JSON.stringify({ pid, socket }));
}

export function pollerBinding(pid = pollerPid()) {
  try {
    const record = JSON.parse(readFileSync(bindingPath(), "utf8"));
    return record?.pid === pid && typeof record.socket === "string" ? { pid, socket: socketPath(record.socket) } : undefined;
  } catch {
    return undefined;
  }
}

// Stops the poller on record and returns once it is gone, so that whatever
// comes next (dropping the old session's pane records, starting the new
// poller) does not overlap with it: a poller told to stop can be in the middle
// of writing a record, and two alive at once both hold the Feishu connection.
export function stopPoller() {
  const pid = pollerPid();
  if (!pid || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (pollerAlive(pid)) {
    if (Date.now() >= deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone just now */
      }
      return;
    }
    sleepSync(20);
  }
}

// Why a running poller should stop, or nothing while it should carry on. The
// poller asks this about itself every POLLER_SELF_CHECK_MS. Everything else
// that keeps the machine at one poller works by stopping the pid on record,
// which a poller that is not on record never hears: one of two started in the
// same instant, one started by hand, one whose session lost Oncall while
// nobody restarted anything. Such a poller went on answering Feishu for the
// wrong session beside the right one (five of them once shared one bot
// token). So the one on record, bound to the session that owns Oncall, is the
// only one that stays, and each poller sees to that itself.
export function pollerSuperseded({ pid = process.pid, socket }) {
  const owner = readOwner();
  if (owner?.socket !== socket) {
    return `oncall belongs to ${owner?.socket ?? "no session"} now, this poller serves ${socket}`;
  }
  const onRecord = pollerPid();
  if (onRecord !== pid) {
    return `the poller on record is ${onRecord || "none"}`;
  }
  return pollerBinding(pid) ? undefined : "poller.json does not name this poller";
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

// A line in poller.log from a process that is not the poller (send-main.mjs),
// stamped the way withTimestamps stamps the poller's own, so every delivery
// into the main session is in the one log. Its stdout belongs to its caller.
export function appendPollerLog(...args) {
  const log = openPollerLog();
  if (log === undefined) {
    return;
  }
  try {
    writeSync(log, `${[new Date().toISOString(), ...args].join(" ")}\n`);
  } finally {
    closeSync(log);
  }
}

// A background node process whose output lands in `poller.log`: the poller
// itself, and the worker that waits for a Feishu scan. It is handed this
// session's herdr socket by name. Left to inherit it, the poller talked to
// whichever server's hook had started it last, which is how it came to serve
// a test session; and a process started from a shell has no socket to inherit.
export function spawnDetached(script, args = []) {
  const log = openPollerLog();
  const child = spawn("/bin/bash", [join(pluginRoot, "bin/run-node.sh"), script, ...args], {
    cwd: pluginRoot,
    detached: true,
    stdio: log === undefined ? "ignore" : ["ignore", log, log],
    // Not the .env this process loaded: the child reads that itself, and keeps
    // reading it, which it could not do if it inherited the values as its own.
    env: { ...startupEnv(), HERDR_SOCKET_PATH: herdrSocket().path },
  });
  if (log !== undefined) {
    // The child holds its own duplicate; leaving this one open would pin the
    // file in every hook process that ever started a poller.
    closeSync(log);
  }
  child.unref();
  return child.pid;
}

function startPoller() {
  const pid = spawnDetached("src/hooks/poll.mjs");
  writePollerPid(pid);
  writePollerBinding({ pid, socket: herdrSocket().path });
  return pid;
}

// One (re)start at a time. Events come in bursts, each in its own hook
// process, and two that both find the poller missing or misbound would each
// start one: the second pid overwrites the first, and the first poller runs on
// with nothing pointing at it. With `waitMs` the caller waits that long for
// its turn; without it, a start that finds another in progress leaves the job
// to that one. Returns undefined when the turn never came.
function withStartLock(work, { waitMs = 0 } = {}) {
  const path = join(stateDir(), "poller.lock");
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (!tryLock(path, { staleMs: START_LOCK_STALE_MS })) {
    if (Date.now() >= deadline) {
      return undefined;
    }
    sleepSync(50);
  }
  try {
    return work();
  } finally {
    unlock(path);
  }
}

// An explicit start waits its turn rather than leave the job to whoever holds
// the lock: that can be a hook of a session that has just lost Oncall, whose
// poller stands down as soon as it comes up, and then there is none.
function inTurn(work, waitMs = START_LOCK_WAIT_MS) {
  const done = withStartLock(work, { waitMs });
  if (done === undefined) {
    throw new Error(`another process held the poller start lock for ${waitMs / 1000} s; no poller was started and nothing was changed`);
  }
  return done;
}

// Why the poller on file will not do for the session that owns Oncall, or
// nothing when it will.
function pollerFault(socket) {
  const pid = pollerPid();
  if (!pollerAlive(pid)) {
    return "none was running";
  }
  const bound = pollerBinding(pid);
  if (!bound) {
    return "the one running had no herdr on record";
  }
  return bound.socket === socket ? undefined : `the one running was bound to ${bound.socket}`;
}

// The poller belongs to the herdr session that owns Oncall, and only that
// session starts, stops or replaces it: in any other session restartPoller and
// ensurePoller do nothing and return 0. They read the ownership and never
// claim it; the entry point that calls them has done that.
export function restartPoller() {
  if (!ownership({ claim: "never" }).mine) {
    return 0;
  }
  return inTurn(() => {
    stopPoller();
    return startPoller();
  });
}

// The `poll` action: Oncall, and its poller, to this session, now. The whole
// move happens under the start lock, in an order that leaves nothing of the
// old session behind: the record says this session, then the old poller is
// stopped and gone, then what it knew about its panes is dropped (after it,
// so it cannot write one more), then this session's poller starts. A move
// that cannot get its turn within `waitMs` changes nothing and throws. Returns
// { own, dropped, pid }; `dropped` only when Oncall came from another session.
export function pollHere({ waitMs } = {}) {
  return inTurn(() => {
    const own = ownership({ claim: "poll" });
    stopPoller();
    const dropped = own.moved ? dropPaneState() : undefined;
    return { own, dropped, pid: startPoller() };
  }, waitMs);
}

// Called on every event in the owner's session, so a poller that died, one
// left by a version that kept no binding, and one bound to another session's
// herdr are all replaced by the next thing that happens, with a line saying
// which it was.
export function ensurePoller({ log = console.log } = {}) {
  const own = ownership({ claim: "never" });
  if (!own.mine) {
    return 0;
  }
  if (!pollerFault(own.socket)) {
    return pollerPid();
  }
  const started = withStartLock(() => {
    // Asked again under the lock: another hook may just have dealt with it.
    const fault = pollerFault(own.socket);
    if (!fault) {
      return pollerPid();
    }
    stopPoller();
    const pid = startPoller();
    log(`poller started · pid ${pid} · herdr ${own.socket} · ${fault}`);
    return pid;
  });
  return started ?? pollerPid();
}
