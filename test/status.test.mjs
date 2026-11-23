import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { oncallStatus } from "../src/lib/index.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NO_NETWORK = join(ROOT, "test", "helpers", "no-network.mjs");
const SECRET = "FAKE-SECRET-123";

// Nothing in this file may read the machine's own state or config. A case that
// leaves one of oncallStatus's inputs to its default would otherwise read the
// live `owner.json`, `enabled` or `drover.env`: it passed on a machine that
// had none, and would have failed on the first one where Oncall is running.
// Here such a default lands in an empty directory instead. (`undefined` is
// "leave it to the default" for a parameter, which is why "no owner on
// record" is passed as null.)
const NOWHERE = mkdtempSync(join(tmpdir(), "oncall-status-defaults-"));
process.env.HERDR_PLUGIN_STATE_DIR = join(NOWHERE, "state");
process.env.HERDR_PLUGIN_CONFIG_DIR = join(NOWHERE, "config");
process.on("exit", () => rmSync(NOWHERE, { recursive: true, force: true }));

// Every field contract section 5 lists, by path. More may be added, none of
// these may go missing or change name.
const CONTRACT_FIELDS = [
  "ok",
  "version",
  "enabled",
  "channels.selected",
  "channels.feishu.paired",
  "channels.feishu.replies_supported",
  "channels.telegram.paired",
  "node.version",
  "poller.alive",
  // Which herdr session Oncall belongs to, and whether the poller is on it.
  "session.socket_path",
  "session.source",
  "owner.socket_path",
  "owner.running",
  "owner.current_session",
  "owner.since",
  "owner.via",
  "poller.pid",
  "poller.socket_path",
  "poller.bound_to_owner",
  "poller.current_session",
  "panel",
  "drover_env.present",
  "drover_env.path",
  "roles.main_agent_name",
  "roles.supervisor_prefix",
  "roles.supervisor_escalate_sec",
  "roles.supervisor_escalate_sec_codex",
  "roles.supervised_escalate_sec",
  "roles.bare_message_target",
  "roles.main_done_ping",
  "roles.main_relay_marker",
  "main_agent.found",
];

function missingFields(status) {
  return CONTRACT_FIELDS.filter((path) => path.split(".").reduce((node, key) => node?.[key], status) === undefined);
}

const PAIRED = {
  CHANNEL: "feishu",
  FEISHU_APP_ID: "cli_fake",
  FEISHU_APP_SECRET: SECRET,
  FEISHU_OPEN_ID: `ou_${SECRET}`,
  TELEGRAM_BOT_TOKEN: SECRET,
  TELEGRAM_CHAT_ID: "",
};

// The herdr session a status call runs in, and another one.
const HERE = { path: "/home/u/.config/herdr/herdr.sock", source: "env" };
const ELSEWHERE = "/home/u/.config/herdr/sessions/drtest-resume2/herdr.sock";

test("status reports what is set up, never a secret", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    return {
      status: 0,
      stdout: JSON.stringify({ result: { agents: [{ name: "drover", pane_id: "w1Z:p1", agent: "claude", agent_status: "idle" }] } }),
    };
  };
  const status = oncallStatus({
    env: { ...PAIRED, MAIN_AGENT_NAME: "drover", BARE_MESSAGE_TARGET: "main", SUPERVISED_ESCALATE_SEC: "600" },
    run,
    pollerAlive: () => true,
    version: "0.6.6",
    panel: "ready",
    enabled: true,
    droverEnv: "/nowhere/drover.env",
    websocket: true,
    nodeVersion: "22.11.0",
    session: HERE,
    owner: { socket: HERE.path, since: 1000, via: "startup" },
    ownerRunning: true,
    poller: { pid: 4242, socket: HERE.path },
  });
  assert.deepEqual(missingFields(status), []);
  assert.deepEqual(status.session, { socket_path: HERE.path, source: "env" });
  assert.deepEqual(status.owner, { socket_path: HERE.path, running: true, current_session: true, since: 1000, via: "startup" });
  assert.deepEqual(status.poller, { alive: true, pid: 4242, socket_path: HERE.path, bound_to_owner: true, current_session: true });
  assert.deepEqual(status.channels, {
    selected: ["feishu"],
    feishu: { paired: true, replies_supported: true },
    telegram: { paired: false },
  });
  assert.deepEqual(status.roles, {
    main_agent_name: "drover",
    supervisor_prefix: "orch-",
    supervisor_escalate_sec: 300,
    supervisor_escalate_sec_codex: 120,
    supervised_escalate_sec: 600,
    bare_message_target: "main",
    main_done_ping: "always",
    main_relay_marker: "【转达】",
  });
  assert.deepEqual(status.main_agent, { found: true, pane_id: "w1Z:p1", agent: "claude", status: "idle" });
  assert.deepEqual(status.drover_env, { present: false, path: "/nowhere/drover.env" });
  assert.ok(!JSON.stringify(status).includes(SECRET));
  assert.deepEqual(calls, ["agent list"]);
});

test("without MAIN_AGENT_NAME the main agent is not looked for", () => {
  const calls = [];
  const status = oncallStatus({
    env: {},
    run: (args) => calls.push(args) && { status: 1 },
    version: "0.6.6",
    panel: "unbuilt",
    enabled: false,
    droverEnv: "/nowhere/drover.env",
    session: HERE,
    owner: null,
  });
  assert.deepEqual(status.main_agent, { found: false });
  assert.equal(status.enabled, false);
  assert.equal(status.roles.bare_message_target, "last");
  assert.deepEqual(calls, []);
  // Nobody has claimed Oncall yet, and no poller is on record.
  assert.deepEqual(status.owner, { socket_path: null, running: null, current_session: false, since: null, via: null });
  assert.deepEqual(status.poller, { alive: false, pid: null, socket_path: null, bound_to_owner: null, current_session: null });
});

// What the incident looked like from `drover oncall status`: "poller alive",
// and nothing else. The poller was alive, bound to a test session that no
// longer existed.
test("status says which herdr the poller is bound to, and whether that is the owner's and this one", () => {
  const down = { status: 1, stderr: `server_not_running: no herdr server is running at ${ELSEWHERE}\n` };
  const base = {
    env: { MAIN_AGENT_NAME: "drover" },
    run: () => down,
    pollerAlive: () => true,
    version: "0.7.3",
    panel: "ready",
    enabled: true,
    droverEnv: "/nowhere/drover.env",
  };
  // Asked from the user's session: it owns Oncall, the poller is somewhere else.
  const hijacked = oncallStatus({
    ...base,
    session: HERE,
    owner: { socket: HERE.path, since: 1, via: "poll" },
    ownerRunning: true,
    poller: { pid: 31044, socket: ELSEWHERE },
  });
  assert.deepEqual(hijacked.poller, { alive: true, pid: 31044, socket_path: ELSEWHERE, bound_to_owner: false, current_session: false });
  assert.equal(hijacked.owner.current_session, true);

  // Asked from a session that does not own it, whose owner's server is gone.
  const outsider = oncallStatus({
    ...base,
    session: { path: ELSEWHERE, source: "env" },
    owner: { socket: HERE.path, since: 1, via: "poll" },
    ownerRunning: false,
    poller: { pid: 31044, socket: HERE.path },
  });
  assert.deepEqual(outsider.owner, { socket_path: HERE.path, running: false, current_session: false, since: 1, via: "poll" });
  assert.deepEqual(outsider.poller, { alive: true, pid: 31044, socket_path: HERE.path, bound_to_owner: true, current_session: false });
  // herdr not answering is reported as that, with the socket asked.
  assert.deepEqual(outsider.main_agent, {
    found: false,
    error: `server_not_running: no herdr server is running at ${ELSEWHERE}`,
    unreachable: true,
    socket_path: ELSEWHERE,
  });

  // A poller started by a version that recorded no binding.
  const legacy = oncallStatus({ ...base, session: HERE, owner: { socket: HERE.path, since: 1, via: "startup" }, poller: { pid: 7 } });
  assert.deepEqual(legacy.poller, { alive: true, pid: 7, socket_path: null, bound_to_owner: null, current_session: null });
});

// The script drover runs, end to end: temp config and state dirs, a .env with
// fake credentials, drover.env as install.py writes it, and a herdr stand-in.
test("the status script prints exactly one line of JSON, and no secret", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oncall-status-")));
  try {
    const config = join(dir, "config");
    const state = join(dir, "state");
    mkdirSync(config);
    mkdirSync(state);
    writeFileSync(
      join(config, ".env"),
      Object.entries(PAIRED)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    writeFileSync(
      join(config, "drover.env"),
      [
        "# 由 drover 的 install.py 写入：重装时整份覆盖，卸载时删除。",
        "MAIN_AGENT_NAME=drover",
        "SUPERVISOR_PREFIX=orch-",
        "SUPERVISOR_ESCALATE_SEC=300",
        "SUPERVISOR_ESCALATE_SEC_CODEX=120",
        "SUPERVISED_ESCALATE_SEC=600",
        "BARE_MESSAGE_TARGET=main",
        "MAIN_DONE_PING=relay",
        "MAIN_RELAY_MARKER=【转达】",
      ].join("\n"),
    );
    const herdr = join(dir, "herdr");
    writeFileSync(
      herdr,
      [
        "#!/bin/sh",
        'if [ "$1" = "agent" ] && [ "$2" = "list" ]; then',
        `  echo '{"result":{"agents":[{"name":"drover","pane_id":"w1Z:p1","agent":"codex","agent_status":"working"}]}}'`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );
    chmodSync(herdr, 0o755);
    const result = spawnSync("/bin/bash", ["bin/run-node.sh", "src/actions/status.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_PLUGIN_STATE_DIR: state,
        HERDR_BIN_PATH: herdr,
        NODE_OPTIONS: `--import "${NO_NETWORK}"`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const status = JSON.parse(lines[0]);
    assert.deepEqual(missingFields(status), []);
    assert.equal(status.ok, true);
    assert.equal(status.drover_env.present, true);
    assert.equal(status.roles.main_agent_name, "drover");
    assert.equal(status.roles.main_done_ping, "relay");
    assert.equal(status.roles.main_relay_marker, "【转达】");
    assert.deepEqual(status.main_agent, { found: true, pane_id: "w1Z:p1", agent: "codex", status: "working" });
    assert.equal(status.channels.feishu.paired, true);
    assert.ok(!result.stdout.includes(SECRET));
    assert.ok(!result.stderr.includes(SECRET));
    // Run the way drover may run it, with no HERDR_SOCKET_PATH: it lands on
    // the default session, as the herdr CLI would from the same shell (the
    // stand-in cannot list sessions, so this is the computed path). And it
    // only reads: asking for the status claims Oncall for nobody.
    assert.deepEqual(status.session, { socket_path: join(dir, ".config", "herdr", "herdr.sock"), source: "default-path" });
    assert.deepEqual(status.owner, { socket_path: null, running: null, current_session: false, since: null, via: null });
    assert.equal(existsSync(join(state, "owner.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
