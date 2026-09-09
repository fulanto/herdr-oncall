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

test("the block above the question is bounded by structure, not a line count", () => {
  // 60 lines of command, far more than any fixed look-back would have kept.
  const command = Array.from({ length: 60 }, (_, i) => `    line ${i + 1} of the script`);
  const screen = [
    "⏺ An earlier assistant turn that must stay out of this.",
    "",
    "❯ run the long script",
    "",
    "⏺ Bash command · from the general-purpose agent",
    ...command,
    "",
    "  This command requires approval",
    "",
    "  Do you want to proceed?",
    "  › 1. Yes",
    "    2. No",
    "",
    "  Esc to cancel · Tab to amend",
  ].join("\n");

  const body = blockedSnippet(screen);
  assert.match(body, /^⏺ Bash command/m);
  assert.match(body, /line 1 of the script/);
  assert.match(body, /line 60 of the script/);
  assert.match(body, /2\. No/);
  assert.doesNotMatch(body, /earlier assistant turn/);
  assert.doesNotMatch(body, /run the long script/);
  assert.doesNotMatch(body, /Esc to cancel/);
});

test("a paragraph break stops the walk when no turn marker is drawn", () => {
  const screen = [
    "unrelated output from before",
    "",
    "",
    "  About to write to /etc/hosts",
    "  Do you want to proceed?",
    "  1. Yes",
    "  2. No",
  ].join("\n");
  const body = blockedSnippet(screen);
  assert.match(body, /About to write/);
  assert.doesNotMatch(body, /unrelated output/);
});

test("options come only from the dialog, not from earlier numbered chat lines", () => {
  const screen = `❯ 1. 毫秒时间戳存时不要上。懒得去跑数据库迁移了
  2. 用子 agent 使用 opus 5 去跑翻译回填脚本
  3. 如果适用 v2 那就移植，如果不适用 v2，那就删。

⏺ Bash command · from the general-purpose agent
  Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

    cd /Users/me/Git-Repo/trizen-doctor && node -e '
    const fs=require("fs");
    const L=["zh","en","ja","de","ar","ko"];
    '
  Dump memory/errorKind/terminalReason groups

  This command requires approval

  Do you want to proceed?
  › 1. Yes
    2. Yes, and don't ask again for: node -e ' *
    3. Yes, and switch to auto mode · auto mode handles these prompts for you
    4. No

  Esc to cancel · Tab to amend`;

  const options = parseBlockedOptions(screen);
  assert.deepEqual(
    options.map((item) => item.label),
    [
      "Yes",
      "Yes, and don't ask again for: node -e ' *",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ],
  );
  assert.deepEqual(
    options.map((item) => item.send),
    ["1", "2", "3", "4"],
  );

  const body = blockedSnippet(screen);
  assert.match(body, /^⏺ Bash command/m);
  assert.match(body, /cd \/Users\/me\/Git-Repo\/trizen-doctor/);
  assert.match(body, /This command requires approval/);
  assert.match(body, /4\. No/);
  assert.doesNotMatch(body, /毫秒时间戳/);
  assert.doesNotMatch(body, /Esc to cancel/);
});

test("blockedSnippet keeps the tail of the screen", () => {
  const screen = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const text = blockedSnippet(screen, 5);
  assert.match(text, /line 30/);
  assert.doesNotMatch(text, /line 1\n/);
});

test("blockedSnippet includes the tool call above a Claude Code question", () => {
  const screen = `⏺ I need to check the pid file, this may need permission.
  Some earlier prose that mentions permission and allow lists.

❯ read the pid file

⏺ Bash(cat ~/.local/state/herdr/plugins/oncall/poller.pid)
  ⎿  Read the poller pid file

  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, allow reading from /Users/me/.local/state/herdr from this project
    3. Yes, and switch to auto mode · auto mode handles these prompts for you
    4. No
✶ Thinking… (12s · ↓ 1.2k tokens)`;
  const text = blockedSnippet(screen);
  assert.match(text, /^⏺ Bash\(cat/m);
  assert.match(text, /Read the poller pid file/);
  assert.match(text, /Do you want to proceed\?/);
  assert.match(text, /4\. No/);
  assert.doesNotMatch(text, /earlier prose/);
  assert.doesNotMatch(text, /read the pid file$/m);
  assert.doesNotMatch(text, /Thinking/);
  const options = parseBlockedOptions(screen);
  assert.deepEqual(
    options.map((item) => item.send),
    ["1", "2", "3", "4"],
  );
});

test("blockedSnippet keeps Codex dialogs starting at the question", () => {
  const screen = `Some assistant output above.
Would you like to run the following command?
Environment: local
$ rm -rf -- /tmp/draft
> 1. Yes, proceed (y)
2. No (esc)`;
  const text = blockedSnippet(screen);
  assert.match(text, /^Would you like to run/);
  assert.doesNotMatch(text, /assistant output above/);
});
