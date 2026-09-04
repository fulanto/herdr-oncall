import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  blockedDelayMs,
  blockedDelayStillMine,
  blockedSnippet,
  doneSnippet,
  extractAgentStatus,
  extractReadText,
  formatMessage,
  markBlockedDelay,
  notifyStatuses,
  optionKeyboard,
  parseBlockedOptions,
  seedConfigEnv,
  shouldNotify,
} from "../src/lib/index.mjs";

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
  assert.match(text, /货架 · pane 2/);
  assert.doesNotMatch(text, /w1:p2/);
  assert.match(text, /waiting for input/);
  assert.match(text, /tap a button/);
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(text), false);
  const done = formatMessage(
    {
      workspace_label: "simple",
      workspace_id: "w8",
      focused_pane_agent: "codex",
      worktree: { repo_name: "asr-service" },
    },
    { data: { pane_id: "w8:p1", agent_status: "done", display_agent: "codex" } },
    "done",
  );
  assert.match(done, /^done · Codex/m);
  assert.match(done, /asr-service · simple · pane 1/);
  assert.doesNotMatch(done, /w8:p1/);
  assert.match(done, /finished/);
});

test("formatMessage done includes the last assistant turn", () => {
  const text = formatMessage(
    {
      workspace_label: "simple",
      focused_pane_agent: "codex",
      worktree: { repo_name: "asr-service" },
    },
    { data: { pane_id: "w8:p1", agent_status: "done", display_agent: "codex" } },
    "done",
    "The debounce is in place.",
  );
  assert.match(text, /^done · Codex/m);
  assert.match(text, /The debounce is in place\./);
  assert.doesNotMatch(text, /^finished$/m);
});

test("doneSnippet keeps the last assistant turn", () => {
  const screen = `exploring files
❯ add a 60s blocked delay
I'll add BLOCKED_DELAY_SEC and skip the ping if you already answered.
Done. Blocked pings now wait 60s.
12345 tokens
esc to interrupt
›
`;
  const text = doneSnippet(screen);
  assert.match(text, /BLOCKED_DELAY_SEC/);
  assert.match(text, /wait 60s/);
  assert.doesNotMatch(text, /add a 60s blocked delay/);
  assert.doesNotMatch(text, /tokens/);
  assert.doesNotMatch(text, /^›$/m);
});

test("extractReadText prefers result.read.text", () => {
  assert.equal(
    extractReadText({ result: { read: { text: "last turn" }, text: "no" } }),
    "last turn",
  );
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
    assert.match(readFileSync(envPath, "utf8"), /BLOCKED_DELAY_SEC=60/);
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

test("blockedDelayMs treats 0 and below as immediate", () => {
  const previous = process.env.BLOCKED_DELAY_SEC;
  delete process.env.BLOCKED_DELAY_SEC;
  try {
    assert.equal(blockedDelayMs(), 60_000);
    assert.equal(blockedDelayMs("0"), 0);
    assert.equal(blockedDelayMs("45"), 45_000);
  } finally {
    if (previous === undefined) {
      delete process.env.BLOCKED_DELAY_SEC;
    } else {
      process.env.BLOCKED_DELAY_SEC = previous;
    }
  }
});

test("extractAgentStatus reads herdr pane get shapes", () => {
  assert.equal(extractAgentStatus({ result: { agent: { state: "blocked" } } }), "blocked");
  assert.equal(extractAgentStatus({ agent_status: "done" }), "done");
  assert.equal(extractAgentStatus({}), undefined);
});

test("a newer blocked wait supersedes an older one", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-state-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    const first = markBlockedDelay("w8:p1", 1000);
    const second = markBlockedDelay("w8:p1", 2000);
    assert.equal(blockedDelayStillMine("w8:p1", first), false);
    assert.equal(blockedDelayStillMine("w8:p1", second), true);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseBlockedOptions reads Codex permission dialogs", () => {
  const screen = `Would you like to run the following command?
Environment: local
$ rm -rf -- /tmp/draft
> 1. Yes, proceed (y)
2. Yes, and don't ask again for commands that start with \`rm -rf -- /tmp/draft\` (p)
3. No, and tell Codex what to do differently (esc)
Press enter to confirm or esc to cancel`;
  const options = parseBlockedOptions(screen);
  assert.deepEqual(
    options.map((item) => item.send),
    ["y", "p", "esc"],
  );
  assert.equal(options[0].label, "Yes, proceed");
  const keyboard = optionKeyboard(options);
  assert.equal(keyboard.inline_keyboard.length, 3);
  const pointed = parseBlockedOptions(`Would you like to run the following command?
› 1. Yes, proceed (y)
  2. Yes, and don't ask again (p)
│ > 3. No, and tell Codex what to do differently (esc)`);
  assert.deepEqual(
    pointed.map((item) => item.send),
    ["y", "p", "esc"],
  );
  const yn = parseBlockedOptions("Allow network? [y/n]");
  assert.deepEqual(
    yn.map((item) => item.send),
    ["y", "n"],
  );
});

test("blockedSnippet keeps the tail of the screen", () => {
  const screen = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const text = blockedSnippet(screen, 5);
  assert.match(text, /line 30/);
  assert.doesNotMatch(text, /line 1\n/);
});
