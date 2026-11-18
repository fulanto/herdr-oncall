import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The script as drover runs it, `run-node.sh src/actions/send-main.mjs …` from
// the plugin root, against a herdr stand-in that records every call. The poller
// is "running" (its pid file names this test process), so a queued click
// starts no real one.
function sandbox({ status = "idle", drover = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-send-main-"));
  const config = join(dir, "config");
  const state = join(dir, "state");
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "poller.pid"), `${process.pid}\n`);
  if (drover) {
    writeFileSync(join(config, "drover.env"), ["MAIN_AGENT_NAME=drover", "BARE_MESSAGE_TARGET=main"].join("\n"));
  }
  const calls = join(dir, "calls");
  const herdr = join(dir, "herdr");
  writeFileSync(
    herdr,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${calls}'`,
      'if [ "$1" = "agent" ] && [ "$2" = "list" ]; then',
      `  echo '{"result":{"agents":[{"name":"drover","pane_id":"w1Z:p1","agent":"claude","agent_status":"${status}"}]}}'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "pane" ] && [ "$2" = "read" ]; then',
      "  printf '%s\\n' '⏺ 好了' '' '❯ '",
      "  exit 0",
      "fi",
      'if [ "$1" = "agent" ] && [ "$2" = "prompt" ]; then',
      "  echo '{}'",
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n"),
  );
  chmodSync(herdr, 0o755);
  const run = (...args) => {
    const result = spawnSync("/bin/bash", ["bin/run-node.sh", "src/actions/send-main.mjs", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_PLUGIN_STATE_DIR: state,
        HERDR_BIN_PATH: herdr,
        // An empty value beats a developer's own .env in the plugin root.
        ...(drover ? {} : { MAIN_AGENT_NAME: "" }),
      },
    });
    const lines = result.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, result.stdout + result.stderr);
    return { code: result.status, json: JSON.parse(lines[0]) };
  };
  const herdrCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
  const file = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : "");
  return { run, herdrCalls, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("send-main types the click into an idle main session and prints one line of JSON, exit 0", () => {
  const box = sandbox();
  try {
    const { code, json } = box.run("--source", "board", "--text", "全部收尾：a、b");
    assert.equal(code, 0);
    assert.deepEqual(json, { ok: true, result: "delivered", reason: "ready", notice: "已送进主会话" });
    assert.ok(box.herdrCalls().includes("agent prompt w1Z:p1 [看板] 全部收尾：a、b"));
    // The delivery is in poller.log, without its text; nothing waits for an answer.
    assert.match(box.file("poller.log"), /main inbox · delivered · 8 chars · idle · board\n$/);
    assert.ok(!box.file("poller.log").includes("全部收尾"));
    assert.equal(box.file("main-pending.json"), "");
  } finally {
    box.cleanup();
  }
});

test("send-main queues the click behind a dialog, exit 0, and leaves a running poller alone", () => {
  const box = sandbox({ status: "blocked" });
  try {
    const { code, json } = box.run("--source", "board", "--text", "收尾：a");
    assert.equal(code, 0);
    assert.deepEqual(json, { ok: true, result: "queued", reason: "blocked", notice: "主会话在等确认，已排队，确认完自动送" });
    assert.ok(!box.herdrCalls().some((line) => line.startsWith("agent prompt")));
    assert.equal(JSON.parse(box.file("main-inbox.json"))[0].text, "[看板] 收尾：a");
    assert.equal(box.file("poller.pid").trim(), String(process.pid));
  } finally {
    box.cleanup();
  }
});

test("send-main without MAIN_AGENT_NAME, or with bad arguments, prints ok:false and exits 1, asking Herdr nothing", () => {
  const box = sandbox({ drover: false });
  try {
    assert.deepEqual(box.run("--source", "board", "--text", "全部收尾：a"), {
      code: 1,
      json: { ok: false, error: "MAIN_AGENT_NAME 没设（不是 drover 环境），没有主会话可送" },
    });
    assert.deepEqual(box.run("--source", "feishu", "--text", "x"), { code: 1, json: { ok: false, error: "--source 只能是 board" } });
    assert.deepEqual(box.run("--source", "board"), { code: 1, json: { ok: false, error: "缺 --text" } });
    assert.deepEqual(box.run("--source", "board", "--text"), { code: 1, json: { ok: false, error: "--text 后面缺值" } });
    assert.deepEqual(box.run("--to", "main"), { code: 1, json: { ok: false, error: "不认识的参数 --to" } });
    assert.deepEqual(box.herdrCalls(), []);
    assert.equal(box.file("main-inbox.json"), "");
  } finally {
    box.cleanup();
  }
});
