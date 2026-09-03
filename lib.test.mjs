import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatMessage, notifyStatuses, seedConfigEnv, shouldNotify } from "./lib.mjs";

test("default notify list is blocked and done", () => {
  assert.deepEqual(notifyStatuses(undefined), ["blocked", "done"]);
  assert.deepEqual(notifyStatuses("blocked, done"), ["blocked", "done"]);
});

test("shouldNotify respects the allow list", () => {
  assert.equal(shouldNotify("blocked"), true);
  assert.equal(shouldNotify("done"), true);
  assert.equal(shouldNotify("working"), false);
  assert.equal(shouldNotify("done", "blocked"), false);
});

test("formatMessage names workspace, pane, and status without emoji", () => {
  const text = formatMessage(
    { workspace_label: "货架", tab_label: "1", focused_pane_agent: "claude" },
    { data: { pane_id: "w1:p2", agent_status: "blocked", display_agent: "claude" } },
    "blocked",
  );
  assert.match(text, /^blocked · Claude/m);
  assert.match(text, /货架 · w1:p2/);
  assert.match(text, /waiting for input/);
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(text), false);
  const done = formatMessage(
    { workspace_label: "货架", focused_pane_agent: "claude" },
    { data: { pane_id: "w1:p2", agent_status: "done", display_agent: "claude" } },
    "done",
  );
  assert.match(done, /^done · Claude/m);
  assert.match(done, /finished/);
});

test("seedConfigEnv copies example and a blank env into the config dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-"));
  const previous = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  try {
    const envPath = seedConfigEnv();
    assert.equal(envPath, join(dir, ".env"));
    const example = readFileSync(join(dir, ".env.example"), "utf8");
    const env = readFileSync(envPath, "utf8");
    assert.match(example, /TELEGRAM_BOT_TOKEN=/);
    assert.match(env, /TELEGRAM_BOT_TOKEN=/);
    writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=keep\nNOTIFY_ON=blocked\n");
    seedConfigEnv();
    assert.match(readFileSync(envPath, "utf8"), /TELEGRAM_BOT_TOKEN=keep/);
    assert.match(readFileSync(envPath, "utf8"), /NOTIFY_ON=blocked,done/);
    assert.match(readFileSync(join(dir, ".env.example"), "utf8"), /CHANNEL=telegram/);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    } else {
      process.env.HERDR_PLUGIN_CONFIG_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
