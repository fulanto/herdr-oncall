import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { herdrJson } from "./herdr.mjs";
import { HERDR_APP_DIRS, PANE_STATE_FILES, runHerdr, stateDir } from "./paths.mjs";
import { actionCommand } from "./setup.mjs";

// Which Herdr session Oncall belongs to.
//
// A machine has one Oncall: one bot, one poller, one state dir. Herdr can run
// several servers at once, though (`herdr --session <name>`), and it calls this
// plugin in every one of them with that same state dir: the startup hook when a
// server starts, the event hook for its panes, any action invoked there. A pane
// id or an agent name only means something inside the server it came from.
//
// Before there was an owner, Oncall belonged to whoever had started the poller
// last. A worker testing Herdr restarts in a named session started that
// session's server eleven times; each start ran the startup hook, which
// restarted the poller with the test session's socket in its environment. The
// user's Feishu taps were then typed at a server that had none of their panes,
// and once the test session was deleted, at a socket nobody listened on:
// "no herdr server is running at …/sessions/<name>/herdr.sock".
//
// So the owner is a record, `<state>/owner.json`, naming a session by its API
// socket path, and it is written in exactly two cases: there is no record yet
// and a session runs any of the plugin's commands, or someone runs the `poll`
// action in a session. Nothing else changes it, and nothing is taken over: a
// session that does not own Oncall leaves the poller and the state alone even
// while the owner's server is not running. Oncall then waits for it to come
// back, and says which socket it is waiting for.
//
// `ownership()` is the one place this is decided.

const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// HERDR_SESSION the way the herdr CLI reads it (src/session.rs, active_name):
// "default", and a name it would refuse, both mean the default session.
function sessionName(env) {
  const name = env.HERDR_SESSION;
  return name && name !== "default" && name !== "." && name !== ".." && SESSION_NAME.test(name) ? name : undefined;
}

// `herdr session list --json` as a list of { name, default, socket_path,
// session_dir, … }; empty when the CLI did not answer with one.
function listedSessions(run) {
  const payload = herdrJson(["session", "list", "--json"], run) ?? {};
  const list = [payload.sessions, payload.result?.sessions].find(Array.isArray) ?? [];
  return list.filter((session) => session instanceof Object);
}

// A session that has never run has no directory for herdr to list yet; its
// socket is still where herdr will put it.
function unlistedSocket(configDir, name) {
  return configDir ? join(configDir, "sessions", name, "herdr.sock") : undefined;
}

function askedSocket(name, run) {
  const sessions = listedSessions(run);
  const fallback = sessions.find((session) => session.default === true) ?? {};
  if (!name) {
    return fallback.socket_path;
  }
  const named = sessions.find((session) => session.name === name) ?? {};
  return named.socket_path ?? unlistedSocket(fallback.session_dir, name);
}

// herdr's own rule (src/config/io.rs, config_dir; src/session.rs,
// api_socket_path_for), for a machine where the CLI cannot be asked.
function computedSocket(name, env) {
  const home = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : tmpdir());
  const dir = HERDR_APP_DIRS.map((app) => join(home, app)).find((path) => existsSync(path)) ?? join(home, HERDR_APP_DIRS[0]);
  return name ? join(dir, "sessions", name, "herdr.sock") : join(dir, "herdr.sock");
}

// One spelling per socket. A session is known by its socket's path, and the
// same socket can be written through a symlink (`/tmp` and `/private/tmp` on a
// Mac): compared as written, the owner's own commands would look like another
// session's and Oncall would go silent in its own session. The socket itself
// may not exist (a server that is down), so it is the deepest directory that
// does exist that is resolved, with the rest of the path put back on.
export function socketPath(path) {
  const full = resolve(String(path));
  const rest = [basename(full)];
  for (let dir = dirname(full); ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...rest);
    } catch {
      if (dirname(dir) === dir) {
        return full;
      }
      rest.unshift(basename(dir));
    }
  }
}

// The CLI costs a process, so its answer is kept for the life of this one. The
// env var is read every time: Herdr sets it per invocation.
let remembered;

// The herdr server this process belongs to, as { path, source }. Herdr hands
// every hook and action HERDR_SOCKET_PATH ("env"). A process started from a
// shell, or by drover outside a pane, may have none, and then the answer is the
// one the herdr CLI would reach from here: HERDR_SESSION's session, else the
// default one ("herdr"), computed the way herdr does when the CLI cannot be
// asked ("default-path").
export function herdrSocket({ env = process.env, run = runHerdr } = {}) {
  const given = env.HERDR_SOCKET_PATH?.trim();
  if (given) {
    return { path: socketPath(given), source: "env" };
  }
  const name = sessionName(env);
  const key = [name, env.XDG_CONFIG_HOME, env.HOME, env.HERDR_BIN_PATH].join("\n");
  if (run === runHerdr && remembered?.key === key) {
    return remembered.value;
  }
  const asked = askedSocket(name, run);
  const value =
    typeof asked === "string" && asked
      ? { path: socketPath(asked), source: "herdr" }
      : { path: socketPath(computedSocket(name, env)), source: "default-path" };
  if (run === runHerdr) {
    remembered = { key, value };
  }
  return value;
}

function ownerPath() {
  return join(stateDir(), "owner.json");
}

// { socket, since, via }, or undefined while nobody owns Oncall. A file that
// does not read as a record is no record.
export function readOwner() {
  try {
    const record = JSON.parse(readFileSync(ownerPath(), "utf8"));
    return typeof record?.socket === "string" && record.socket ? { ...record, socket: socketPath(record.socket) } : undefined;
  } catch {
    return undefined;
  }
}

function tempRecord(record) {
  const path = ownerPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record), "utf8");
  return temp;
}

function replaceOwner(record) {
  renameSync(tempRecord(record), ownerPath());
  return record;
}

// The first claim. Two sessions can find Oncall unclaimed in the same instant
// (two servers starting together); a hard link either creates the record whole
// or fails because it exists, so exactly one of them gets it and the other
// reads the winner's.
function createOwner(record) {
  const temp = tempRecord(record);
  try {
    linkSync(temp, ownerPath());
    return record;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return readOwner() ?? replaceOwner(record);
}

function recordCount(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(value)) {
      return value.length;
    }
    return value && typeof value === "object" ? Object.keys(value).length : 0;
  } catch {
    return 0;
  }
}

// What the previous owner knew about its panes means nothing in another
// session, where the same pane ids are other panes. Returns how many records
// each file held. A message waiting in main-inbox.json names no pane (the main
// session is found by name when it goes in), so it stays, for the main session
// of the session Oncall belongs to now. Called by the move itself
// (`pollHere` in inbound/poller.mjs) once the old session's poller is gone, so
// that poller cannot write one more record after the files are dropped.
export function dropPaneState() {
  const dropped = {};
  for (const name of PANE_STATE_FILES) {
    const path = join(stateDir(), name);
    if (existsSync(path)) {
      dropped[name] = recordCount(path);
      rmSync(path, { force: true });
    }
  }
  return dropped;
}

// How this process was started, for the record: an action's id, the event
// name ("startup" for the startup hook), or a shell.
function invokedVia(env) {
  if (env.HERDR_PLUGIN_ACTION_ID) {
    return `action ${env.HERDR_PLUGIN_ACTION_ID}`;
  }
  return env.HERDR_PLUGIN_EVENT || "shell";
}

// Whether Oncall belongs to the herdr session this process runs in:
// { mine, socket, source, owner } where `socket` is this session's and `owner`
// the record ({ socket, since, via }, undefined while unclaimed).
//
//   claim "first" (every entry point)  an unclaimed Oncall becomes this
//                                      session's (`claimed: true`)
//   claim "poll"  (the poll action)    it becomes this session's whoever had
//                                      it; when it moves, `moved` is { from },
//                                      and the caller has the old session's
//                                      poller and pane records to deal with
//   claim "never" (status, re-checks)  only reads
//
// Whether the owner's server is running plays no part: see the top of the file.
export function ownership({ claim = "first", env = process.env, run = runHerdr, now = Date.now() } = {}) {
  const me = herdrSocket({ env, run });
  const mine = { socket: me.path, source: me.source };
  const recorded = readOwner();
  if (claim === "poll" && recorded?.socket !== me.path) {
    const owner = replaceOwner({ socket: me.path, since: now, via: "poll" });
    return recorded ? { ...mine, mine: true, owner, moved: { from: recorded.socket } } : { ...mine, mine: true, owner, claimed: true };
  }
  if (!recorded && claim === "first") {
    const owner = createOwner({ socket: me.path, since: now, via: invokedVia(env) });
    return { ...mine, mine: owner.socket === me.path, owner, ...(owner.socket === me.path ? { claimed: true } : {}) };
  }
  return { ...mine, mine: recorded?.socket === me.path, owner: recorded };
}

// Whether Oncall is on record as another session's. For a process about to
// write down something about a pane after it has waited on the network: the
// ownership it checked when it started may have moved since. An unclaimed
// Oncall is nobody else's.
export function ownedElsewhere() {
  const owner = readOwner();
  return Boolean(owner) && owner.socket !== herdrSocket().path;
}

// Why this session's command did nothing, and the one way to change that.
export function notOwnerReason(own) {
  const holder = own.owner ? `${own.owner.socket} does` : "no session has claimed it yet";
  return `this herdr session (${own.socket}) does not own Oncall, ${holder}; to move it here: ${actionCommand("poll")}`;
}

// What to say when the ownership was just written: the log is where someone
// will look to see when Oncall went to which session. `dropped` is what
// dropPaneState() removed when it moved.
export function ownershipLines(own, dropped = {}) {
  if (own.moved) {
    const counts = Object.entries(dropped)
      .map(([name, count]) => `${name} ${count}`)
      .join(", ");
    return [`oncall moved · ${own.moved.from} → ${own.socket} · pane records of the old session dropped: ${counts || "none on file"}`];
  }
  if (own.claimed) {
    return [`oncall claimed · ${own.socket} · the first herdr session to run it; another session gets it only with: ${actionCommand("poll")}`];
  }
  return [];
}

// For an entry point that works only for the session that owns Oncall: returns
// the ownership when this session has it, and otherwise prints why nothing was
// done and exits. A hook exits 0 (another session's event is not an error); an
// action someone asked for exits 1.
export function ownerOrExit(what, { code = 1, ...options } = {}) {
  const own = ownership(options);
  for (const line of ownershipLines(own)) {
    console.log(line);
  }
  if (!own.mine) {
    (code ? console.error : console.log)(`${what} · ${notOwnerReason(own)}`);
    process.exit(code);
  }
  return own;
}

// Whether a herdr server is listening on this socket, decided the way herdr
// decides a session is running (src/session.rs, session_info): a connection is
// accepted. true, false, or null when it cannot be told (a permission error, no
// answer in time). Only `status` asks, for a person to read.
export function socketAlive(path, { timeoutMs = 1000 } = {}) {
  return new Promise((done) => {
    const socket = net.createConnection({ path });
    const settle = (value) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs, () => settle(null));
    socket.once("connect", () => settle(true));
    socket.once("error", (error) => settle(["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(error?.code) ? false : null));
  });
}
