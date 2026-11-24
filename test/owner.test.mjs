import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PANE_STATE_FILES,
  dropPaneState,
  eventGate,
  herdrSocket,
  notOwnerReason,
  ownership,
  ownershipLines,
  paneStatePath,
  readOwner,
  socketAlive,
  socketPath,
  tryLock,
  unlock,
} from "../src/lib/index.mjs";
import { lookupOutbound, rememberOutbound } from "../src/inbound/reply.mjs";
import { pollHere, pollerSuperseded, writePollerBinding, writePollerPid } from "../src/inbound/poller.mjs";

// Which herdr session Oncall belongs to (src/lib/owner.mjs). Two sessions, as
// in the incident these rules come from: the user's, and a test session
// started with `herdr --session test-session-2`. The paths are under a
// directory that does not exist, so they read the same on every machine: a
// socket's path is resolved through the directories that do exist, and `/home`
// and `/tmp` are symlinks on a Mac.
const CONFIG = "/oncall-test/herdr";
const A = `${CONFIG}/herdr.sock`;
const B = `${CONFIG}/sessions/test-session-2/herdr.sock`;
const POLL = "herdr plugin action invoke poll --plugin com.codreamer.herdr.oncall";

const inSession = (socket, extra = {}) => ({ HERDR_SOCKET_PATH: socket, ...extra });

// Both of the machine's directories point into a temp dir for every case here:
// the state, and the config too, so that nothing a case starts or reads by
// default could find the real pairing.
function withState(body) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-owner-unit-"));
    const previous = { state: process.env.HERDR_PLUGIN_STATE_DIR, config: process.env.HERDR_PLUGIN_CONFIG_DIR };
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    process.env.HERDR_PLUGIN_CONFIG_DIR = join(dir, "config");
    try {
      await body(dir);
    } finally {
      for (const [key, value] of [
        ["HERDR_PLUGIN_STATE_DIR", previous.state],
        ["HERDR_PLUGIN_CONFIG_DIR", previous.config],
      ]) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// `herdr session list --json`, as herdr 0.9.5 prints it.
function sessionList(...named) {
  const config = CONFIG;
  const sessions = [
    { default: true, name: "default", running: true, session_dir: config, socket_path: `${config}/herdr.sock` },
    ...named.map((name) => ({
      default: false,
      name,
      running: false,
      session_dir: `${config}/sessions/${name}`,
      socket_path: `${config}/sessions/${name}/herdr.sock`,
    })),
  ];
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    return { status: 0, stdout: JSON.stringify({ sessions }) };
  };
  return { run, calls };
}

test("the session a process belongs to is the socket Herdr handed it", () => {
  const herdr = sessionList();
  assert.deepEqual(herdrSocket({ env: inSession(B, { HERDR_SESSION: "something-else" }), run: herdr.run }), { path: B, source: "env" });
  // Herdr sets the socket for every hook and action; the CLI is not asked.
  assert.deepEqual(herdr.calls, []);
});

test("with no socket in the environment it is where the herdr CLI would go: HERDR_SESSION's session, else the default", () => {
  const herdr = sessionList("test-session-2");
  assert.deepEqual(herdrSocket({ env: {}, run: herdr.run }), { path: A, source: "herdr" });
  assert.deepEqual(herdr.calls, ["session list --json"]);
  assert.deepEqual(herdrSocket({ env: { HERDR_SESSION: "test-session-2" }, run: herdr.run }), { path: B, source: "herdr" });
  // A session that has never run is not listed yet; its socket is still known.
  assert.equal(herdrSocket({ env: { HERDR_SESSION: "new-one" }, run: herdr.run }).path, `${CONFIG}/sessions/new-one/herdr.sock`);
  // "default", and a name herdr would refuse, are the default session.
  for (const name of ["default", "..", "has space", "a/b"]) {
    assert.equal(herdrSocket({ env: { HERDR_SESSION: name }, run: herdr.run }).path, A, name);
  }
});

test("when the CLI cannot be asked, the socket is computed the way herdr computes it", () => {
  const none = () => ({ status: 1, stdout: "", stderr: "herdr: command not found" });
  assert.deepEqual(herdrSocket({ env: { HOME: "/nowhere/u" }, run: none }), {
    path: "/nowhere/u/.config/herdr/herdr.sock",
    source: "default-path",
  });
  assert.equal(herdrSocket({ env: { HOME: "/nowhere/u", XDG_CONFIG_HOME: "/nowhere/xdg" }, run: none }).path, "/nowhere/xdg/herdr/herdr.sock");
  assert.equal(
    herdrSocket({ env: { HOME: "/nowhere/u", HERDR_SESSION: "work" }, run: none }).path,
    "/nowhere/u/.config/herdr/sessions/work/herdr.sock",
  );
  // An answer that is not a session list is no answer.
  assert.equal(herdrSocket({ env: { HOME: "/nowhere/u" }, run: () => ({ status: 0, stdout: "not json" }) }).source, "default-path");
});

test(
  "an unclaimed Oncall goes to the first session that runs a command, and stays there",
  withState(async () => {
    assert.equal(readOwner(), undefined);
    const first = ownership({ env: inSession(A, { HERDR_PLUGIN_EVENT: "startup" }), now: 1000 });
    assert.deepEqual(first, { socket: A, source: "env", mine: true, owner: { socket: A, since: 1000, via: "startup" }, claimed: true });
    assert.deepEqual(readOwner(), { socket: A, since: 1000, via: "startup" });
    assert.deepEqual(ownershipLines(first), [`oncall claimed · ${A} · the first herdr session to run it; another session gets it only with: ${POLL}`]);

    // The other session: a startup, an event, an action, whatever it runs.
    for (const how of [{ HERDR_PLUGIN_EVENT: "startup" }, { HERDR_PLUGIN_EVENT: "pane.agent_status_changed" }, { HERDR_PLUGIN_ACTION_ID: "test" }]) {
      const other = ownership({ env: inSession(B, how), now: 2000 });
      assert.equal(other.mine, false);
      assert.equal(other.claimed, undefined);
      assert.deepEqual(ownershipLines(other), []);
      assert.equal(notOwnerReason(other), `this herdr session (${B}) does not own Oncall, ${A} does; to move it here: ${POLL}`);
    }
    assert.deepEqual(readOwner(), { socket: A, since: 1000, via: "startup" });

    // Back in A, nothing is written again and nothing is said.
    const again = ownership({ env: inSession(A), now: 3000 });
    assert.equal(again.mine, true);
    assert.deepEqual(ownershipLines(again), []);
    assert.equal(readOwner().since, 1000);
  }),
);

test(
  "how the claim came about is on the record",
  withState(async (dir) => {
    assert.equal(ownership({ env: inSession(A, { HERDR_PLUGIN_ACTION_ID: "pair-feishu" }) }).owner.via, "action pair-feishu");
    rmSync(join(dir, "owner.json"));
    assert.equal(ownership({ env: inSession(A, { HERDR_PLUGIN_EVENT: "pane.agent_status_changed" }) }).owner.via, "pane.agent_status_changed");
    rmSync(join(dir, "owner.json"));
    assert.equal(ownership({ env: inSession(A) }).owner.via, "shell");
  }),
);

test(
  "reading the ownership claims nothing",
  withState(async (dir) => {
    const read = ownership({ claim: "never", env: inSession(A) });
    assert.deepEqual(read, { socket: A, source: "env", mine: false, owner: undefined });
    assert.equal(existsSync(join(dir, "owner.json")), false);
    assert.equal(notOwnerReason(read), `this herdr session (${A}) does not own Oncall, no session has claimed it yet; to move it here: ${POLL}`);

    ownership({ env: inSession(A) });
    assert.equal(ownership({ claim: "never", env: inSession(A) }).mine, true);
    assert.equal(ownership({ claim: "never", env: inSession(B) }).mine, false);
  }),
);

test(
  "a file that does not read as a record is no record",
  withState(async (dir) => {
    for (const junk of ["", "{not json", JSON.stringify({ socket: "" }), JSON.stringify([A])]) {
      writeFileSync(join(dir, "owner.json"), junk);
      assert.equal(readOwner(), undefined);
      const claimed = ownership({ env: inSession(A), now: 5 });
      assert.equal(claimed.mine, true, junk);
      assert.deepEqual(readOwner(), { socket: A, since: 5, via: "shell" });
    }
  }),
);

test(
  "poll moves Oncall to the session it is run in; dropping what the old one knew about its panes is the mover's next step",
  withState(async (dir) => {
    ownership({ env: inSession(A), now: 1000 });
    const records = {
      "outbound.json": { om_1: { paneId: "w1:p1" }, om_2: { paneId: "w1:p2" } },
      "escalations.json": { "w1:p3": { paneId: "w1:p3" } },
      "main-pending.json": [{ id: "p1", paneId: "w1:p1" }],
      "panels.json": {},
      "blocked-delay.json": { "w1:p1": 1 },
    };
    for (const [name, value] of Object.entries(records)) {
      writeFileSync(join(dir, name), JSON.stringify(value));
    }
    // What names no pane, or is the machine's, is not the old session's.
    const kept = { "main-inbox.json": '[{"id":"waiting"}]', enabled: "disabled\n", "telegram-offset": "42\n", "poller.pid": "123\n" };
    for (const [name, text] of Object.entries(kept)) {
      writeFileSync(join(dir, name), text);
    }

    const moved = ownership({ claim: "poll", env: inSession(B, { HERDR_PLUGIN_ACTION_ID: "poll" }), now: 2000 });
    assert.deepEqual(moved, { socket: B, source: "env", mine: true, owner: { socket: B, since: 2000, via: "poll" }, moved: { from: A } });
    assert.equal(ownership({ env: inSession(A) }).mine, false);
    // The record moves first and alone: the old session's poller is still
    // running at this point, and its files go only once it has been stopped
    // (pollHere, inbound/poller.mjs).
    for (const name of Object.keys(records)) {
      assert.ok(existsSync(join(dir, name)), name);
    }

    const dropped = dropPaneState();
    assert.deepEqual(dropped, { "outbound.json": 2, "escalations.json": 1, "main-pending.json": 1, "panels.json": 0, "blocked-delay.json": 1 });
    assert.deepEqual(ownershipLines(moved, dropped), [
      `oncall moved · ${A} → ${B} · pane records of the old session dropped: outbound.json 2, escalations.json 1, main-pending.json 1, panels.json 0, blocked-delay.json 1`,
    ]);
    assert.deepEqual(ownershipLines(moved, {}), [`oncall moved · ${A} → ${B} · pane records of the old session dropped: none on file`]);
    for (const name of PANE_STATE_FILES) {
      assert.equal(existsSync(join(dir, name)), false, name);
    }
    for (const [name, text] of Object.entries(kept)) {
      assert.equal(readFileSync(join(dir, name), "utf8"), text, name);
    }

    // poll where Oncall already is: nothing is written, and nothing has moved.
    const same = ownership({ claim: "poll", env: inSession(B), now: 3000 });
    assert.deepEqual(same, { socket: B, source: "env", mine: true, owner: { socket: B, since: 2000, via: "poll" } });
    assert.deepEqual(ownershipLines(same), []);
  }),
);

test(
  "poll on an unclaimed Oncall is a first claim: there is no old session whose records to drop",
  withState(async (dir) => {
    writeFileSync(join(dir, "outbound.json"), '{"om_1":{"paneId":"w1:p1"}}');
    const claimed = ownership({ claim: "poll", env: inSession(A), now: 1 });
    assert.deepEqual(claimed, { socket: A, source: "env", mine: true, owner: { socket: A, since: 1, via: "poll" }, claimed: true });
    assert.ok(existsSync(join(dir, "outbound.json")));
  }),
);

test(
  "a file that names panes gets its path from the list that is dropped when Oncall moves",
  withState(async (dir) => {
    assert.equal(paneStatePath("outbound.json"), join(dir, "outbound.json"));
    assert.throws(() => paneStatePath("main-inbox.json"), /not in PANE_STATE_FILES/);
  }),
);

test("an event from a session that does not own Oncall says why when someone waits on it, and nothing otherwise", () => {
  const notOwner = `this herdr session (${B}) does not own Oncall, ${A} does; to move it here: ${POLL}`;
  assert.deepEqual(eventGate("blocked", { notOwner }), { go: false, reason: notOwner });
  assert.deepEqual(eventGate("done", { notOwner }), { go: false, reason: notOwner });
  assert.deepEqual(eventGate("working", { notOwner }), { go: false, reason: "" });
  assert.deepEqual(eventGate("idle", { notOwner }), { go: false, reason: "" });
});

// A hook checks the ownership, sends its ping over the network, and only then
// writes down which pane the ping was about. `poll` in another session can
// land in between. The record must not go into the new owner's state: a done
// ping's reply is not checked against a dialog, so its words would be typed
// into whatever pane has that id there.
test(
  "a ping is not written down once Oncall belongs to another session",
  withState(async () => {
    const record = { messageId: "om_1", paneId: "w1:p1", status: "done", where: "repo · main · pane 1", channel: "feishu" };
    const previous = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = A;
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try {
      // Unclaimed, and claimed by this session: written, as ever.
      rememberOutbound(record, 1000);
      assert.equal(lookupOutbound("om_1", 1000).paneId, "w1:p1");
      ownership({ env: inSession(A) });
      rememberOutbound({ ...record, messageId: "om_2" }, 1000);
      assert.equal(lookupOutbound("om_2", 1000).paneId, "w1:p1");
      assert.deepEqual(lines, []);

      // Oncall moves while this process's ping is on its way.
      ownership({ claim: "poll", env: inSession(B) });
      rememberOutbound({ ...record, messageId: "om_3" }, 1000);
      assert.equal(lookupOutbound("om_3", 1000), undefined);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^not recorded · repo · main · pane 1 · /);
    } finally {
      console.log = log;
      if (previous === undefined) {
        delete process.env.HERDR_SOCKET_PATH;
      } else {
        process.env.HERDR_SOCKET_PATH = previous;
      }
    }
  }),
);

// A session is known by its socket's path, so two spellings of one socket
// must be one session. Compared as written, the owner's own commands looked
// like another session's, and Oncall would have stayed silent in its own
// session until someone ran poll.
test(
  "one socket reached through a symlink is one session",
  withState(async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "oncall-link-")));
    try {
      mkdirSync(join(dir, "herdr"));
      symlinkSync(join(dir, "herdr"), join(dir, "by-link"));
      const real = join(dir, "herdr", "herdr.sock");
      const linked = join(dir, "by-link", "herdr.sock");
      assert.equal(socketPath(linked), real);
      assert.equal(socketPath(`${dir}/herdr/../herdr/herdr.sock`), real);
      // A directory that is not there yet (a session that has never run) is
      // resolved as far as the path exists.
      assert.equal(socketPath(join(dir, "by-link", "sessions", "new", "herdr.sock")), join(dir, "herdr", "sessions", "new", "herdr.sock"));

      assert.equal(ownership({ env: inSession(linked) }).owner.socket, real);
      assert.equal(ownership({ env: inSession(real) }).mine, true);
      assert.equal(ownership({ env: inSession(linked) }).mine, true);
      // A record written the other way round, by hand or by an older build.
      writeFileSync(join(process.env.HERDR_PLUGIN_STATE_DIR, "owner.json"), JSON.stringify({ socket: linked, since: 1, via: "poll" }));
      assert.equal(readOwner().socket, real);
      assert.equal(ownership({ env: inSession(real) }).mine, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);

// The poller asks this about itself every few seconds. Stopping a poller by
// its pid only reaches the one on record; any other has to notice by itself.
test(
  "a poller carries on only while it is the one on record, for the session that owns Oncall",
  withState(async () => {
    const me = { pid: 4242, socket: A };
    ownership({ env: inSession(A) });
    writePollerPid(4242);
    writePollerBinding({ pid: 4242, socket: A });
    assert.equal(pollerSuperseded(me), undefined);

    // Another poller is on record: started in the same instant, or by hand.
    writePollerPid(5151);
    assert.equal(pollerSuperseded(me), "the poller on record is 5151");
    writePollerPid(4242);
    writePollerBinding({ pid: 5151, socket: A });
    assert.equal(pollerSuperseded(me), "poller.json does not name this poller");
    rmSync(join(process.env.HERDR_PLUGIN_STATE_DIR, "poller.pid"));
    assert.equal(pollerSuperseded(me), "the poller on record is none");

    // Oncall went to another session, and nobody stopped this poller.
    writePollerPid(4242);
    writePollerBinding({ pid: 4242, socket: A });
    ownership({ claim: "poll", env: inSession(B) });
    assert.equal(pollerSuperseded(me), `oncall belongs to ${B} now, this poller serves ${A}`);
    rmSync(join(process.env.HERDR_PLUGIN_STATE_DIR, "owner.json"));
    assert.equal(pollerSuperseded(me), `oncall belongs to no session now, this poller serves ${A}`);
  }),
);

// `poll` waits its turn for the poller start lock (the wait itself, and what
// follows it, are in test/owner-entry.test.mjs with a real poller). When the
// turn never comes, it must fail loudly and leave everything as it was: it
// used to come back with the old session's poller pid as if it had worked.
test(
  "a move that cannot get its turn changes nothing and says so",
  withState(async (dir) => {
    ownership({ env: inSession(A) });
    writePollerPid(999_999);
    writeFileSync(join(dir, "outbound.json"), '{"om_1":{"paneId":"w1:p1"}}');
    // Held by a live process for as long as this waits.
    writeFileSync(join(dir, "poller.lock"), `${process.pid}\n`);
    const previous = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = B;
    try {
      assert.throws(() => pollHere({ waitMs: 150 }), /held the poller start lock for 0\.15 s; no poller was started and nothing was changed/);
    } finally {
      if (previous === undefined) {
        delete process.env.HERDR_SOCKET_PATH;
      } else {
        process.env.HERDR_SOCKET_PATH = previous;
      }
      // Should it ever get through and start one, that poller does not stay.
      const started = Number(readFileSync(join(dir, "poller.pid"), "utf8"));
      if (started !== 999_999) {
        process.kill(started, "SIGKILL");
      }
    }
    assert.equal(readOwner().socket, A);
    assert.equal(readFileSync(join(dir, "poller.pid"), "utf8"), "999999\n");
    assert.ok(existsSync(join(dir, "outbound.json")));
    assert.equal(readFileSync(join(dir, "poller.lock"), "utf8"), `${process.pid}\n`, "the other process still holds its lock");
  }),
);

test("a herdr server is running when something accepts a connection on its socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-sock-"));
  try {
    const path = join(dir, "herdr.sock");
    const server = net.createServer((connection) => connection.destroy());
    await new Promise((resolve) => server.listen(path, resolve));
    assert.equal(await socketAlive(path), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await socketAlive(path), false);
    assert.equal(await socketAlive(join(dir, "never-was.sock")), false);
    writeFileSync(join(dir, "plain-file"), "");
    assert.equal(await socketAlive(join(dir, "plain-file")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock is one process's until it is released, and one left by a dead process is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-lock-"));
  try {
    const path = join(dir, "x.lock");
    assert.equal(tryLock(path, { staleMs: 60_000 }), true);
    assert.equal(readFileSync(path, "utf8"), `${process.pid}\n`);
    assert.equal(tryLock(path, { staleMs: 60_000 }), false, "held by a live process");
    unlock(path);
    assert.equal(existsSync(path), false);

    writeFileSync(path, `${spawnSync(process.execPath, ["-e", ""]).pid}\n`);
    assert.equal(tryLock(path, { staleMs: 60_000 }), true, "its holder is gone");
    // Held by a live process, but for longer than anything holds it.
    assert.equal(tryLock(path, { staleMs: -1 }), true);
    unlock(path);

    // Two processes find the same lock abandoned. The first takes it over;
    // the second, which made up its mind before that, must not remove the
    // first one's new lock and take it too.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(path, `${gone}\n`);
    const firstTakesOver = () => {
      rmSync(path);
      writeFileSync(path, `${process.ppid}\n`);
    };
    assert.equal(tryLock(path, { staleMs: 60_000, meanwhile: firstTakesOver }), false);
    assert.equal(readFileSync(path, "utf8"), `${process.ppid}\n`, "the first one's lock is still its own");
    assert.deepEqual(
      readdirSync(dir).filter((name) => name !== "x.lock"),
      [],
      "nothing is left lying beside it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
