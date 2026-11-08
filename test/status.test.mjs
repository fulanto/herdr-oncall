import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { oncallStatus } from "../src/lib/index.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = "FAKE-SECRET-123";

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
  "panel",
  "drover_env.present",
  "drover_env.path",
  "roles.main_agent_name",
  "roles.supervisor_prefix",
  "roles.supervisor_escalate_sec",
  "roles.supervisor_escalate_sec_codex",
  "roles.supervised_escalate_sec",
  "roles.bare_message_target",
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
  });
  assert.deepEqual(missingFields(status), []);
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
  });
  assert.deepEqual(status.main_agent, { found: false });
  assert.equal(status.enabled, false);
  assert.equal(status.roles.bare_message_target, "last");
  assert.deepEqual(calls, []);
});

// The script drover runs, end to end: temp config and state dirs, a .env with
// fake credentials, drover.env as install.py writes it, and a herdr stand-in.
test("the status script prints exactly one line of JSON, and no secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-status-"));
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
    assert.deepEqual(status.main_agent, { found: true, pane_id: "w1Z:p1", agent: "codex", status: "working" });
    assert.equal(status.channels.feishu.paired, true);
    assert.ok(!result.stdout.includes(SECRET));
    assert.ok(!result.stderr.includes(SECRET));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
