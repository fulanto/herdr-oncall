import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The incident these cases come from: a worker tested Herdr restarts in a named
// session (`herdr --session test-session-2`), and every start of that server
// ran this plugin's startup hook against the one state dir a machine has. The
// hook restarted the poller with the test session's socket, so the user's
// Feishu taps went to a server that had none of their panes, and after the
// test session was deleted, to a socket nobody listened on.
//
// Everything here goes through the real entry points (`bin/run-node.sh …`),
// with two herdr sessions: A is the user's, B is the test session. Each has a
// socket this test listens on, and the herdr stand-in answers by the
// HERDR_SOCKET_PATH it is called with, logging every call with it. The poller
// these entries start is the real one, and is killed when the case ends.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NO_NETWORK = join(ROOT, "test", "helpers", "no-network.mjs");
const PLUGIN_ID = "com.codreamer.herdr.oncall";
const PANE = "w1:p1";
const PANE_FILES = ["outbound.json", "escalations.json", "main-pending.json", "panels.json", "blocked-delay.json", "last-notify.json"];

const STARTUP = { HERDR_PLUGIN_EVENT: "startup" };
function paneEvent(status) {
  return {
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { pane_id: PANE, agent_status: status, display_agent: "claude" } }),
    HERDR_PLUGIN_CONTEXT_JSON: "{}",
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function herdrScript({ calls, dir, aSocket, aMainStatus, aDialog }) {
  return [
    "#!/bin/sh",
    `printf '%s | %s\\n' "$HERDR_SOCKET_PATH" "$*" >> '${calls}'`,
    "session=b",
    `[ "$HERDR_SOCKET_PATH" = '${aSocket}' ] && session=a`,
    'case "$1 $2" in',
    // A is the machine's default session, B a named one that has not been listed.
    '  "session list")',
    `    echo '{"sessions":[{"default":true,"name":"default","running":true,"session_dir":"${dir}","socket_path":"${aSocket}"}]}'`,
    "    exit 0 ;;",
    '  "agent list")',
    // A is where drover's main session lives; B has only a worker.
    '    if [ "$session" = a ]; then',
    `      status=$(cat '${aMainStatus}' 2>/dev/null || echo idle)`,
    `      echo "{\\"result\\":{\\"agents\\":[{\\"name\\":\\"drover\\",\\"pane_id\\":\\"${PANE}\\",\\"agent\\":\\"claude\\",\\"agent_status\\":\\"$status\\"}]}}"`,
    "    else",
    `      echo '{"result":{"agents":[{"name":"api-e2e","pane_id":"${PANE}","agent":"claude","agent_status":"blocked"}]}}'`,
    "    fi",
    "    exit 0 ;;",
    '  "agent get")',
    `    echo '{"result":{"agent":{"name":"api-e2e","pane_id":"${PANE}","agent":"claude","agent_status":"blocked"}}}'`,
    "    exit 0 ;;",
    '  "pane read")',
    // A's pane is idle unless a case puts a dialog on it; B's always asks.
    `    if [ "$session" = a ] && [ ! -f '${aDialog}' ]; then`,
    "      printf '%s\\n' '⏺ 好了' '' '❯ '",
    "    else",
    "      printf '%s\\n' '⏺ Bash(git push origin main)' '' '  Do you want to proceed?' '  ❯ 1. Yes' '    2. No' '' '  Esc to cancel · Tab to amend'",
    "    fi",
    "    exit 0 ;;",
    '  "pane get")',
    `    echo '{"result":{"pane":{"agent_status":"blocked","focused":false}}}'`,
    "    exit 0 ;;",
    '  "agent prompt")',
    "    echo '{}'",
    "    exit 0 ;;",
    "esac",
    "exit 1",
  ].join("\n");
}

async function sandbox({ drover = true } = {}) {
  // The real path: a session is known by its socket's, and the system temp
  // dir is reached through a symlink on a Mac.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oncall-owner-")));
  const config = join(dir, "config");
  const state = join(dir, "state");
  mkdirSync(config);
  mkdirSync(state);
  if (drover) {
    writeFileSync(join(config, "drover.env"), ["MAIN_AGENT_NAME=drover", "BARE_MESSAGE_TARGET=main"].join("\n"));
  }
  const A = { socket: join(dir, "a.sock") };
  const B = { socket: join(dir, "b.sock"), name: "test-session-2" };
  // A build step: Herdr strips its socket, its session and every HERDR_PLUGIN_
  // variable from a build's environment (the two directories stay here only
  // to keep the case in its sandbox).
  const BUILD = {};
  const calls = join(dir, "calls");
  const aMainStatus = join(dir, "a-main-status");
  const aDialog = join(dir, "a-dialog");
  const herdr = join(dir, "herdr");
  writeFileSync(herdr, herdrScript({ calls, dir, aSocket: A.socket, aMainStatus, aDialog }));
  chmodSync(herdr, 0o755);

  // "The server is running" is a listener on its socket, as it is for herdr.
  const servers = new Map();
  const listen = (session) =>
    new Promise((resolve, reject) => {
      const server = net.createServer((connection) => connection.destroy());
      server.once("error", reject);
      server.listen(session.socket, () => {
        servers.set(session, server);
        resolve();
      });
    });
  const stopServer = (session) =>
    new Promise((resolve) => {
      const server = servers.get(session);
      servers.delete(session);
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  await listen(A);
  await listen(B);

  const file = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : "");
  const json = (name) => (file(name) ? JSON.parse(file(name)) : undefined);
  const put = (name, value) => writeFileSync(join(state, name), JSON.stringify(value));
  // Every poller a case ever saw, so none outlives it. Never this process: a
  // case that put its own pid on record would be killed by its own cleanup.
  const pollers = new Set();
  const pollerPid = () => {
    const pid = Number(file("poller.pid").trim()) || 0;
    if (pid && pid !== process.pid) {
      pollers.add(pid);
    }
    return pid;
  };
  // A poller writes its own binding as it comes up; a case that edits the
  // records waits for that first.
  const up = (pid) => waitFor(() => file("poller.log").includes(`oncall poller started pid=${pid} `), `poller ${pid} to come up`);
  // A live process that stands in for a poller: on record where a case puts
  // it, doing `onStop` when it is told to stop. Killed with the rest.
  const standIn = (onStop = "process.exit(0);") =>
    new Promise((resolve, reject) => {
      const code = `process.on("SIGTERM", () => { ${onStop} }); setInterval(() => {}, 1000); console.log("ready");`;
      const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
      child.on("error", reject);
      child.stdout.once("data", () => {
        pollers.add(child.pid);
        resolve(child.pid);
      });
    });
  const record = (pid, socket) => {
    writeFileSync(join(state, "poller.pid"), `${pid}\n`);
    put("poller.json", { pid, socket });
  };

  const run = (session, script, { args = [], env = {} } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["bin/run-node.sh", script, ...args], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          NODE_OPTIONS: `--import "${NO_NETWORK}"`,
          HERDR_PLUGIN_CONFIG_DIR: config,
          HERDR_PLUGIN_STATE_DIR: state,
          HERDR_BIN_PATH: herdr,
          ...(session.socket ? { HERDR_ENV: "1", HERDR_PLUGIN_ID: PLUGIN_ID, HERDR_SOCKET_PATH: session.socket } : {}),
          ...(session.name ? { HERDR_SESSION: session.name } : {}),
          // A channel has to count as paired for the hook to get as far as
          // writing anything. A token that is never used: the poller does not
          // poll, a worker's dialog is only written down, and the network is
          // off in every process anyway. Empty values beat a developer's own
          // .env in the plugin root.
          CHANNEL: "telegram",
          TELEGRAM_BOT_TOKEN: "not-a-token",
          TELEGRAM_CHAT_ID: "1",
          TELEGRAM_POLL: "0",
          FEISHU_APP_ID: "",
          FEISHU_APP_SECRET: "",
          FEISHU_OPEN_ID: "",
          FEISHU_DOMAIN: "",
          AUTO_UPDATE: "0",
          DESKTOP_PANEL: "0",
          INSTALL_AGENT_INTEGRATION: "0",
          HERDR_TELEGRAM_SET_TITLE: "0",
          BLOCKED_DELAY_SEC: "0",
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      // An entry that turns into a long-running process is a failure, not a hang.
      const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(guard);
        pollerPid();
        resolve({ code, signal, stdout, stderr, out: stdout + stderr });
      });
    });

  const herdrCalls = (session) => {
    const lines = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
    return session ? lines.filter((line) => line.startsWith(`${session.socket} | `)).map((line) => line.slice(session.socket.length + 3)) : lines;
  };

  const cleanup = async () => {
    pollerPid();
    for (const pid of pollers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await Promise.all([...servers.keys()].map(stopServer));
    rmSync(dir, { recursive: true, force: true });
  };

  return { A, B, BUILD, config, state, file, json, put, pollerPid, up, standIn, record, run, herdrCalls, stopServer, aMainStatus, aDialog, cleanup };
}

// A message waiting for the main session: the poller's first act is to look
// for the main session, which shows which herdr it asks.
function boardItem(id, text) {
  return { id, text: `[看板] ${text}`, chars: Array.from(text).length, channel: "board", at: Date.now() };
}

test("another herdr session starting up leaves the owner's poller alone", async () => {
  const box = await sandbox();
  try {
    box.put("main-inbox.json", [boardItem("first", "接上")]);
    const first = await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    assert.equal(first.code, 0, first.out);
    const pid = box.pollerPid();
    assert.ok(alive(pid), "A's startup starts the poller");
    await waitFor(() => box.herdrCalls(box.A).includes(`agent prompt ${PANE} [看板] 接上`), "the poller to reach A's main session");

    const second = await box.run(box.B, "src/actions/seed.mjs", { env: STARTUP });
    assert.equal(second.code, 0, second.out);
    assert.equal(box.pollerPid(), pid, "B's startup must not replace A's poller");
    assert.ok(alive(pid));
    assert.equal(box.json("owner.json").socket, box.A.socket);
    assert.deepEqual(box.json("poller.json"), { pid, socket: box.A.socket });
    assert.match(second.stdout, /does not own Oncall/);
    assert.ok(second.stdout.includes(box.A.socket), second.stdout);
    assert.ok(second.stdout.includes(`herdr plugin action invoke poll --plugin ${PLUGIN_ID}`), second.stdout);

    // And the poller still asks A's herdr, not B's.
    box.put("main-inbox.json", [boardItem("second", "再接上")]);
    await waitFor(() => box.herdrCalls(box.A).includes(`agent prompt ${PANE} [看板] 再接上`), "the poller to reach A's main session again");
    assert.deepEqual(box.herdrCalls(box.B), [], "nothing asked B's herdr anything");
  } finally {
    await box.cleanup();
  }
});

test("a blocked event in a session that does not own Oncall writes nothing and says why; working stays silent", async () => {
  const box = await sandbox();
  try {
    await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    const pid = box.pollerPid();

    const blocked = await box.run(box.B, "src/hooks/notify.mjs", { env: paneEvent("blocked") });
    assert.equal(blocked.code, 0, blocked.out);
    for (const name of PANE_FILES) {
      assert.equal(box.file(name), "", `${name} must not hold a record from B: ${box.file(name)}`);
    }
    assert.match(blocked.stdout, new RegExp(`^not sent · blocked · ${PANE} · .*does not own Oncall`, "m"));
    assert.deepEqual(box.herdrCalls(box.B), [], "the hook stopped before asking B's herdr anything");

    const working = await box.run(box.B, "src/hooks/notify.mjs", { env: paneEvent("working") });
    assert.equal(working.code, 0);
    assert.equal(working.out, "", "an event nobody waits on stays silent");

    assert.equal(box.pollerPid(), pid);
    assert.ok(alive(pid));
    assert.equal(box.json("owner.json").socket, box.A.socket);
  } finally {
    await box.cleanup();
  }
});

test("the owner's server going away hands nothing over; only poll moves Oncall, and it drops the old session's pane records", async () => {
  const box = await sandbox();
  try {
    await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    const pid = box.pollerPid();
    const status = async (session) => JSON.parse((await box.run(session, "src/actions/status.mjs")).stdout);
    assert.equal((await status(box.A)).owner.running, true);

    // A's server stops: nobody listens on its socket any more.
    await box.stopServer(box.A);
    assert.equal((await box.run(box.B, "src/actions/seed.mjs", { env: STARTUP })).code, 0);
    assert.equal((await box.run(box.B, "src/hooks/notify.mjs", { env: paneEvent("blocked") })).code, 0);
    assert.equal(box.pollerPid(), pid, "B does not take over while A is away");
    assert.ok(alive(pid));
    assert.equal(box.json("owner.json").socket, box.A.socket);
    assert.equal(box.file("escalations.json"), "");
    const away = await status(box.B);
    assert.deepEqual(
      { socket: away.owner.socket_path, running: away.owner.running, here: away.owner.current_session },
      { socket: box.A.socket, running: false, here: false },
    );

    // What A left behind. Its main session is in a dialog, so its poller keeps
    // the queued message where it is.
    writeFileSync(box.aMainStatus, "blocked");
    const waiting = boardItem("kept", "全部收尾：a");
    box.put("main-inbox.json", [waiting]);
    box.put("outbound.json", { om_1: { paneId: PANE, status: "done", at: Date.now() }, om_2: { paneId: PANE, status: "blocked", at: Date.now() } });
    box.put("escalations.json", { [PANE]: { paneId: PANE, role: "worker", name: "api-e2e", startedAt: Date.now() } });
    box.put("main-pending.json", [{ id: "p1", paneId: PANE, channel: "feishu", messageId: "om_9", text: "[飞书] 进度？", deliveredAt: Date.now() }]);
    box.put("panels.json", { [PANE]: { pid: 999_999, kind: "blocked" } });
    box.put("blocked-delay.json", { [PANE]: 1 });
    box.put("last-notify.json", { [`${PANE}:blocked`]: 1 });

    const moved = await box.run(box.B, "src/actions/poll.mjs");
    assert.equal(moved.code, 0, moved.out);
    const next = box.pollerPid();
    assert.notEqual(next, pid);
    assert.ok(alive(next));
    await waitFor(() => !alive(pid), "A's poller to stop");
    assert.equal(box.json("owner.json").socket, box.B.socket);
    assert.deepEqual(box.json("poller.json"), { pid: next, socket: box.B.socket });
    for (const name of PANE_FILES) {
      assert.equal(box.file(name), "", `${name} named A's panes and must be gone`);
    }
    assert.match(moved.stdout, /outbound\.json 2/);
    assert.match(moved.stdout, /escalations\.json 1/);
    assert.ok(moved.stdout.includes(box.A.socket) && moved.stdout.includes(box.B.socket), moved.stdout);
    // A queued message names no pane: it is still there, for the main session
    // of the herdr Oncall belongs to now.
    assert.equal(box.json("main-inbox.json")[0].id, "kept");
    await waitFor(() => box.herdrCalls(box.B).includes("agent list"), "the new poller to ask B's herdr");

    // A is the outsider now.
    const back = await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    assert.match(back.stdout, /does not own Oncall/);
    assert.equal(box.pollerPid(), next);

    // poll again where Oncall already is: a restart, and nothing dropped.
    box.put("outbound.json", { om_3: { paneId: PANE, status: "done", at: Date.now() } });
    const again = await box.run(box.B, "src/actions/poll.mjs");
    assert.equal(again.code, 0, again.out);
    assert.notEqual(box.pollerPid(), next);
    assert.deepEqual(Object.keys(box.json("outbound.json")), ["om_3"]);
    assert.equal(box.json("owner.json").socket, box.B.socket);
  } finally {
    await box.cleanup();
  }
});

test("the owner session restarts a poller that is bound to another herdr, or has no binding on record", async () => {
  const box = await sandbox();
  try {
    await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    const first = box.pollerPid();
    const event = () => box.run(box.A, "src/hooks/notify.mjs", { env: paneEvent("working") });
    const up = box.up;
    await up(first);

    // Healthy: an event leaves it alone, without a word.
    const quiet = await event();
    assert.equal(quiet.out, "");
    assert.equal(box.pollerPid(), first);

    // The state the incident left: a live poller bound to the other session.
    box.put("poller.json", { pid: first, socket: box.B.socket });
    const healed = await event();
    assert.equal(healed.code, 0, healed.out);
    const second = box.pollerPid();
    assert.notEqual(second, first);
    assert.ok(alive(second));
    await waitFor(() => !alive(first), "the misbound poller to stop");
    assert.deepEqual(box.json("poller.json"), { pid: second, socket: box.A.socket });
    assert.ok(healed.stdout.includes(box.B.socket), healed.stdout);
    await up(second);
    assert.ok(box.file("poller.log").includes(`oncall poller started pid=${second} herdr=${box.A.socket}`));

    // A poller started by a version that kept no binding.
    rmSync(join(box.state, "poller.json"));
    await event();
    const third = box.pollerPid();
    assert.notEqual(third, second);
    assert.deepEqual(box.json("poller.json"), { pid: third, socket: box.A.socket });
    await up(third);

    // An event from the other session heals nothing and changes nothing.
    box.put("poller.json", { pid: third, socket: box.B.socket });
    await box.run(box.B, "src/hooks/notify.mjs", { env: paneEvent("working") });
    assert.equal(box.pollerPid(), third);
    assert.deepEqual(box.json("poller.json"), { pid: third, socket: box.B.socket });
  } finally {
    await box.cleanup();
  }
});

test("a hook that was waiting when Oncall moved to another session sends nothing afterwards", async () => {
  // Without drover, so the pane is the user's own and its dialog is theirs.
  const box = await sandbox({ drover: false });
  try {
    await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    writeFileSync(box.aDialog, "");
    // A's pane asks something, with two seconds to wait before the phone.
    const waiting = box.run(box.A, "src/hooks/notify.mjs", { env: { ...paneEvent("blocked"), BLOCKED_DELAY_SEC: "2" } });
    await waitFor(() => box.file("blocked-delay.json") !== "", "the hook to start its wait");

    const moved = await box.run(box.B, "src/actions/poll.mjs");
    assert.equal(moved.code, 0, moved.out);

    const hook = await waiting;
    assert.equal(hook.code, 0, hook.out);
    assert.match(hook.stdout, /^not sent · .*does not own Oncall/m);
    assert.ok(!/ping failed|^sent · /m.test(hook.out), hook.out);
    assert.equal(box.file("outbound.json"), "");
  } finally {
    await box.cleanup();
  }
});

test("poll waits its turn while a poller is being started elsewhere, then leaves Oncall here with a poller of its own", async () => {
  const box = await sandbox();
  try {
    await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    const pid = box.pollerPid();
    await box.up(pid);

    // A hook of the old session is in the middle of starting a poller: it
    // holds the start lock. (This process stands in for it: alive, as it is.)
    const lock = join(box.state, "poller.lock");
    writeFileSync(lock, `${process.pid}\n`);
    const moving = box.run(box.B, "src/actions/poll.mjs");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const during = { owner: box.json("owner.json").socket, poller: box.pollerPid() };
    rmSync(lock);

    const moved = await moving;
    assert.equal(moved.code, 0, moved.out);
    const next = box.pollerPid();
    assert.notEqual(next, pid, "poll must not come back with the old session's poller");
    assert.ok(alive(next));
    assert.deepEqual(box.json("poller.json"), { pid: next, socket: box.B.socket });
    assert.equal(box.json("owner.json").socket, box.B.socket);
    assert.match(moved.stdout, new RegExp(`^poller pid ${next} · herdr `, "m"));
    await waitFor(() => !alive(pid), "the old session's poller to stop");
    // While it waited, nothing had moved: the move happens whole, under the lock.
    assert.deepEqual(during, { owner: box.A.socket, poller: pid });
  } finally {
    await box.cleanup();
  }
});

test("a poller that is not the one on record, or whose session no longer owns Oncall, stops by itself", async () => {
  const box = await sandbox();
  try {
    await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    const stray = box.pollerPid();
    await box.up(stray);

    // Another poller is on record (two were started at once, one was started
    // by hand): nothing will ever stop this one, so it has to notice.
    box.record(await box.standIn(), box.A.socket);
    await waitFor(() => !alive(stray), "the poller that is not on record to stop", 12_000);
    assert.match(box.file("poller.log"), new RegExp(`oncall poller stopping pid=${stray} · `));

    // A poller on record whose session lost Oncall without anyone stopping it.
    rmSync(join(box.state, "poller.pid"));
    rmSync(join(box.state, "poller.json"));
    await box.run(box.A, "src/hooks/notify.mjs", { env: paneEvent("working") });
    const left = box.pollerPid();
    await box.up(left);
    box.put("owner.json", { socket: box.B.socket, since: Date.now(), via: "poll" });
    await waitFor(() => !alive(left), "the old owner's poller to stop", 12_000);
    assert.ok(box.file("poller.log").includes(`oncall poller stopping pid=${left} · oncall belongs to ${box.B.socket} now`));
  } finally {
    await box.cleanup();
  }
});

test("when Oncall moves, the old poller is gone before its pane records are dropped", async () => {
  const box = await sandbox();
  try {
    // A's poller, as a stand-in that writes one more pane record on its way
    // out, the way a real one can be in the middle of a delivery.
    const late = join(box.state, "outbound.json");
    const record = JSON.stringify({ om_late: { paneId: PANE, status: "done", at: Date.now() } });
    const old = await box.standIn(
      `require("node:fs").writeFileSync(${JSON.stringify(late)}, ${JSON.stringify(record)}); setTimeout(() => process.exit(0), 300);`,
    );
    box.put("owner.json", { socket: box.A.socket, since: 1, via: "startup" });
    box.record(old, box.A.socket);

    const moved = await box.run(box.B, "src/actions/poll.mjs");
    assert.equal(moved.code, 0, moved.out);
    assert.ok(!alive(old), "the old poller is gone when poll returns");
    assert.equal(box.file("outbound.json"), "", "what the old poller wrote as it stopped is dropped with the rest");
    assert.equal(box.json("owner.json").socket, box.B.socket);
    const next = box.pollerPid();
    assert.ok(alive(next));
    assert.deepEqual(box.json("poller.json"), { pid: next, socket: box.B.socket });
  } finally {
    await box.cleanup();
  }
});

test("a build is nobody's command: it claims nothing, and restarts the poller only where the default session already owns Oncall", async () => {
  const box = await sandbox();
  try {
    // A fresh install: Oncall is unclaimed, and the build leaves it so.
    const fresh = await box.run(box.BUILD, "src/actions/seed.mjs");
    assert.equal(fresh.code, 0, fresh.out);
    assert.equal(box.file("owner.json"), "");
    assert.equal(box.pollerPid(), 0, "no poller before any session has run Oncall");
    assert.match(fresh.stdout, /^config: /m);
    assert.match(fresh.stdout, /^poller: starts with the first herdr session that runs Oncall$/m);

    // The first session to run anything of Oncall's gets it, poller and all.
    const first = await box.run(box.A, "src/hooks/notify.mjs", { env: paneEvent("working") });
    const pid = box.pollerPid();
    assert.ok(alive(pid), first.out);
    assert.equal(box.json("owner.json").socket, box.A.socket);
    assert.match(first.stdout, /^oncall claimed · /m);

    // An update's build while the default session (A) owns Oncall: the new
    // code's poller takes over at once.
    const update = await box.run(box.BUILD, "src/actions/seed.mjs");
    const next = box.pollerPid();
    assert.notEqual(next, pid);
    assert.deepEqual(box.json("poller.json"), { pid: next, socket: box.A.socket });
    assert.match(update.stdout, new RegExp(`^poller: ${next}$`, "m"));

    // With another session the owner, a build leaves that session's poller be.
    await box.run(box.B, "src/actions/poll.mjs");
    const theirs = box.pollerPid();
    const other = await box.run(box.BUILD, "src/actions/seed.mjs");
    assert.equal(other.code, 0, other.out);
    assert.equal(box.pollerPid(), theirs);
    assert.ok(alive(theirs));
    assert.ok(other.stdout.includes(`poller: left alone · it serves the herdr session at ${box.B.socket}`), other.stdout);
    assert.equal(box.json("owner.json").socket, box.B.socket);
  } finally {
    await box.cleanup();
  }
});

test("where Oncall does not belong, every action but status and poll is refused, and nothing is touched", async () => {
  const box = await sandbox();
  try {
    await box.run(box.A, "src/actions/seed.mjs", { env: STARTUP });
    const pid = box.pollerPid();
    const env = readFileSync(join(box.config, ".env"), "utf8");
    // No token: an action that got past the refusal would stop at its own
    // "nothing configured" before trying to reach anything.
    const unpaired = { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" };

    const refused = [
      ["src/actions/toggle.mjs", ["off"]],
      ["src/actions/test.mjs", []],
      ["src/actions/pair.mjs", []],
      ["src/actions/pair-feishu.mjs", []],
      ["src/actions/unpair-feishu.mjs", []],
    ];
    for (const [script, args] of refused) {
      const result = await box.run(box.B, script, { args, env: unpaired });
      assert.equal(result.code, 1, `${script}: ${result.out}`);
      assert.match(result.out, /does not own Oncall/, script);
      assert.ok(result.out.includes(`herdr plugin action invoke poll --plugin ${PLUGIN_ID}`), script);
    }
    for (const name of ["enabled", "pair.json", "feishu-pair.json"]) {
      assert.equal(box.file(name), "", name);
    }
    assert.equal(readFileSync(join(box.config, ".env"), "utf8"), env);

    // drover's board, run from the other session: one line of JSON, nothing typed, nothing queued.
    const send = await box.run(box.B, "src/actions/send-main.mjs", { args: ["--source", "board", "--text", "全部收尾：a"] });
    assert.equal(send.code, 1);
    const lines = send.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, send.out);
    const answer = JSON.parse(lines[0]);
    assert.equal(answer.ok, false);
    assert.ok(answer.error.includes(box.A.socket) && answer.error.includes("归属"), answer.error);
    assert.equal(box.file("main-inbox.json"), "");
    assert.deepEqual(box.herdrCalls(box.B), []);

    // setup links and seeds as ever, and leaves the poller where it is.
    const setup = await box.run(box.B, "src/actions/install.mjs");
    assert.equal(setup.code, 0, setup.out);
    assert.match(setup.stdout, /^poller: left alone · .*does not own Oncall/m);

    // The poller itself, started by hand in the wrong session, stands down.
    const stray = await box.run(box.B, "src/hooks/poll.mjs");
    assert.equal(stray.signal, null, "it must exit by itself");
    assert.match(stray.out, /does not own Oncall/);

    // status answers anywhere, and claims nothing.
    const status = JSON.parse((await box.run(box.B, "src/actions/status.mjs")).stdout);
    assert.equal(status.ok, true);
    assert.deepEqual(status.session, { socket_path: box.B.socket, source: "env" });
    assert.deepEqual(
      { socket: status.owner.socket_path, running: status.owner.running, here: status.owner.current_session },
      { socket: box.A.socket, running: true, here: false },
    );
    assert.deepEqual(status.poller, { alive: true, pid, socket_path: box.A.socket, bound_to_owner: true, current_session: false });

    assert.equal(box.pollerPid(), pid);
    assert.ok(alive(pid));
    assert.equal(box.json("owner.json").socket, box.A.socket);
    assert.deepEqual(box.json("poller.json"), { pid, socket: box.A.socket });
  } finally {
    await box.cleanup();
  }
});
