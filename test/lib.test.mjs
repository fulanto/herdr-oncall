import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentDetectionSkipped,
  blockedDelayMs,
  blockedDelayStillMine,
  blockedSnippet,
  consecutiveGate,
  decideBlockedReal,
  dialogChoices,
  dialogFingerprint,
  doneSnippet,
  extractAgentStatus,
  extractDetectionSkipped,
  extractReadText,
  formatMessage,
  nextDialog,
  markBlockedDelay,
  notifyStatuses,
  optionKeyboard,
  parseBlockedOptions,
  readScreenSettled,
  screenHasLiveDialog,
  screenHasOpenMenu,
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

test("a done ping carries the answer, not the footer under the prompt box", () => {
  // Captured from a real pane. Claude Code's mode footer reads "⏵⏵ accept edits
  // on (shift+tab to cycle)" on a bare pane, but with monitors or agents
  // attached it drops the key hint entirely — and nothing else here matched it,
  // so it read as content. The prompt box compounds it: "❯ <typed text>" is
  // indistinguishable from a turn the user sent, so the body was sliced to
  // everything below the box, which is only chrome. The panel opened on a done
  // ping whose entire body was that one footer line.
  const rule = "─".repeat(60);
  const pane = (box) =>
    [
      "⏺ 继续等待。",
      "",
      "✻ Cooked for 5s · done 10:59 AM · 1 monitor still running",
      "",
      rule,
      box,
      rule,
      "  ➜ his-claw-agent git:(Copilot5) ctx:52% Fable 5.1",
      "  ⏵⏵ accept edits on · 1 monitor · ← 1 agent",
    ].join("\n");

  // The box holds a non-breaking space when it is empty.
  const idle = doneSnippet(pane("❯ "));
  // …and reads like a sent turn once anything is typed into it.
  const typed = doneSnippet(pane("❯ auto模式我这会有限流"));
  for (const text of [idle, typed]) {
    assert.match(text, /^⏺ 继续等待。/);
    assert.doesNotMatch(text, /accept edits on/);
    assert.doesNotMatch(text, /ctx:52%/);
    assert.doesNotMatch(text, /auto模式/);
  }
  assert.equal(idle, typed);
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

test("a live dialog survives the terminal footers drawn under it", () => {
  // The labelled separator ("──── ↯ ─") and the status footers are chrome. An
  // earlier version stopped scanning at the separator and reported no dialog,
  // which would have swallowed a real notification.
  const screen = [
    "⏺ Bash(rm -rf -- /tmp/draft)",
    "  ⎿  Contains brace with quote character",
    "",
    "  Do you want to proceed?",
    "  ❯ 1. Yes",
    "    2. No",
    "",
    "  Esc to cancel · Tab to amend",
    "────────────────────────────────────────────────────── ↯ ─",
    "  ➜ herdr-oncall git:(main) ✗ ctx:33% Opus 5 (1M context)",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  assert.equal(screenHasLiveDialog(screen), true);
  assert.deepEqual(
    parseBlockedOptions(screen).map((item) => item.label),
    ["Yes", "No"],
  );
  assert.doesNotMatch(blockedSnippet(screen), /ctx:33%/);
});

test("an idle screen with a labelled separator has no live dialog", () => {
  const screen = [
    "⏺ 说明文字。",
    "✻ Baked for 5m · done 3:23 PM",
    "─────────────────────────────── ↯  change-default-asr-provider ─",
    "❯ 把注释补上",
    "─────────────────────────────────────────────────────────────────",
    "  ➜ asr-service git:(feature) ✗ ctx:20% Opus 5",
  ].join("\n");
  assert.equal(screenHasLiveDialog(screen), false);
});

test("a live dialog is the last thing on screen", () => {
  // Shape captured from a real blocked Claude Code pane.
  const live = [
    "⏺ Bash(rm -rf -- /tmp/draft)",
    "  ⎿  Contains brace with quote character (expansion obfuscation)",
    "",
    "  Do you want to proceed?",
    "  ❯ 1. Yes",
    "    2. Yes, and switch to auto mode · auto mode handles these prompts for you",
    "    3. No",
    "",
    "  Esc to cancel · Tab to amend",
  ].join("\n");
  assert.equal(screenHasLiveDialog(live), true);
});

test("a dialog quoted in the transcript is not live", () => {
  // Shape captured from this repo's own pane: the agent printed a permission
  // prompt while discussing it, which is what pins Herdr's detector at blocked.
  const quoted = [
    "⏺ 这条规则匹配屏幕上的字面文本：",
    "",
    "  Do you want to proceed?",
    "  ❯ 1. Yes",
    "    2. No",
    "",
    "  所以这个 pane 会被误判成 blocked。文本滚出缓冲区后会自愈。",
    "",
    "✻ Baked for 5m 7s · done 3:23 PM",
    "─────────────────────────────────────────────────── ↯ ─",
    "❯",
    "─────────────────────────────────────────────────────────",
    "  ➜ herdr-oncall git:(main) ✗ ctx:33% Opus 5 (1M context)",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  assert.equal(screenHasLiveDialog(quoted), false);
});

test("a working screen with no dialog at all is not live", () => {
  const working = [
    "⏺ 编译通过。现在看检测器看到了什么。",
    "",
    "✽ Determining… (52s · ↓ 3.0k tokens)",
    "─────────────────────────────────────────────────── ↯ ─",
    "❯",
    "─────────────────────────────────────────────────────────",
    "  ➜ herdr-oncall git:(main) ✗ ctx:33% Opus 5",
  ].join("\n");
  assert.equal(screenHasLiveDialog(working), false);
  assert.equal(screenHasLiveDialog(""), false);
  assert.equal(screenHasLiveDialog("   \n\n"), false);
});

test("the dynamic workflow prompt is live when it is the bottom of the screen", () => {
  assert.equal(
    screenHasLiveDialog(
      ["Run a dynamic workflow?", "", "  › 1. Yes, run it", "    2. No", "", "  Esc to cancel · Tab to amend"].join(
        "\n",
      ),
    ),
    true,
  );
});

test("a numbered description list above the choices is not mistaken for them", () => {
  const screen = [
    "Run a dynamic workflow?",
    "",
    "  │ Adversarially review the tool/gateway/interactive payload slots",
    "",
    "  This dynamic workflow will spin up multiple subagents across the following phases:",
    "    1. Review — three lenses over the uncommitted round-3 edits",
    "       · \"${…}nn${…}nnReport only findings you verified by reading co…\"",
    "",
    "  Dynamic workflows can use a lot of tokens quickly by running many subagents in parallel — which counts against your usage limit. Stop a running workflow at any time with /workflows.",
    "",
    "  › 1. Yes, run it",
    "    2. View raw script",
    "    3. No",
    "",
    "  Esc to cancel · Tab to amend",
    "  ctrl+g to edit script in $EDITOR",
  ].join("\n");

  const options = parseBlockedOptions(screen);
  assert.deepEqual(
    options.map((item) => item.label),
    ["Yes, run it", "View raw script", "No"],
  );
  assert.deepEqual(
    options.map((item) => item.send),
    ["1", "2", "3"],
  );

  const body = blockedSnippet(screen);
  assert.match(body, /^Run a dynamic workflow\?/m);
  assert.match(body, /Adversarially review/);
  assert.match(body, /1\. Review — three lenses/);
  assert.match(body, /3\. No/);
  assert.doesNotMatch(body, /Esc to cancel/);
  assert.doesNotMatch(body, /ctrl\+g/);
});

test("a wrapped option keeps its continuation line out of the choice list", () => {
  const screen = [
    "⏺ Bash(cat /etc/hosts)",
    "",
    "  Do you want to proceed?",
    "  › 1. Yes",
    "    2. Yes, allow reading from /Users/me/.local/state/herdr/plugins",
    "       from this project",
    "    3. No",
    "",
    "  Esc to cancel",
  ].join("\n");
  const options = parseBlockedOptions(screen);
  assert.deepEqual(
    options.map((item) => item.key),
    ["1", "2", "3"],
  );
  assert.match(blockedSnippet(screen), /from this project/);
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

test("only a real keystroke in parentheses becomes a send key", () => {
  // "(default)" used to pass the old "alphanumeric and short" rule, so tapping
  // that button typed the word "default" into the pane.
  const screen = [
    "⏺ Edit(src/app.ts)",
    "",
    "  Do you want to make this edit?",
    "  ❯ 1. Yes (default)",
    "    2. Yes, allow all edits during this session (shift+tab)",
    "    3. No (esc)",
    "",
    "  Esc to cancel",
  ].join("\n");
  assert.deepEqual(parseBlockedOptions(screen), [
    { key: "1", send: "1", label: "Yes (default)" },
    { key: "2", send: "2", label: "Yes, allow all edits during this session (shift+tab)" },
    { key: "3", send: "esc", label: "No" },
  ]);

  // Codex's real shortcuts still survive.
  const codex = parseBlockedOptions(`Would you like to run the following command?
$ rm -rf -- /tmp/draft
> 1. Yes, proceed (y)
2. Yes, and don't ask again (p)
3. No (esc)`);
  assert.deepEqual(
    codex.map((item) => item.send),
    ["y", "p", "esc"],
  );
  assert.deepEqual(
    codex.map((item) => item.label),
    ["Yes, proceed", "Yes, and don't ask again", "No"],
  );
});

test("an option's shortcut wrapped onto its own line is not a footer", () => {
  // Captured from a real pane: the second choice is long enough that Claude
  // Code puts its "(shift+tab)" on the next line. That parenthetical matched
  // the key-hint chrome rule, so the walk up the choice list ended there — the
  // panel offered one button ("3. No") and pushed the other two choices into
  // the body, which began at the question instead of at the turn marker.
  const screen = [
    "⏺ Update(supabase-dump.sh)",
    "  ⎿  Updated supabase-dump.sh with 3 additions",
    "",
    "  Do you want to make this edit to supabase-dump.sh?",
    "  ❯ 1. Yes",
    "    2. Yes, and always allow access to /Users/fangtao/.local/bin for this session",
    "       (shift+tab)",
    "    3. No",
    "",
    "  Esc to cancel · Tab to amend",
    "──────────────────────────────────────────────────── ↯ ─",
    "  ➜ trizen-doctor git:(main) ✗ ctx:42% Opus 5",
  ].join("\n");
  assert.equal(screenHasLiveDialog(screen), true);
  // The tail is joined back onto the label it was wrapped off, so the button
  // reads as the agent wrote the choice.
  assert.deepEqual(parseBlockedOptions(screen), [
    { key: "1", send: "1", label: "Yes" },
    {
      key: "2",
      send: "2",
      label: "Yes, and always allow access to /Users/fangtao/.local/bin for this session (shift+tab)",
    },
    { key: "3", send: "3", label: "No" },
  ]);
  const text = blockedSnippet(screen);
  assert.match(text, /^⏺ Update\(supabase-dump\.sh\)/);
  assert.match(text, /1\. Yes$/m);
  assert.doesNotMatch(text, /ctx:42%/);

  // The footer it was confused with still reads as chrome: a key hint says what
  // the key does, and that is what tells the two apart.
  assert.equal(
    screenHasLiveDialog(
      [...screen.split("\n"), "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"].join("\n"),
    ),
    true,
  );
});

test("a wrapped option is read exactly like the same option unwrapped", () => {
  // The tail under the *last* choice is the first thing the scan up from the
  // bottom meets, so it has to be stepped over rather than treated as the end
  // of the dialog — otherwise this screen has no options at all.
  const wrapped = [
    "⏺ Edit(src/app.ts)",
    "",
    "  Do you want to make this edit?",
    "  ❯ 1. Yes (default)",
    "    2. Yes, allow all edits during this session",
    "       (shift+tab)",
    "    3. No, and tell Claude what to do differently",
    "       (esc)",
    "",
    "  Esc to cancel",
  ].join("\n");
  assert.equal(screenHasLiveDialog(wrapped), true);
  // Byte for byte what the unwrapped fixture above yields: "(shift+tab)" is not
  // a keystroke so it stays in the label, "(esc)" is one so it becomes the key.
  assert.deepEqual(parseBlockedOptions(wrapped), [
    { key: "1", send: "1", label: "Yes (default)" },
    { key: "2", send: "2", label: "Yes, allow all edits during this session (shift+tab)" },
    { key: "3", send: "esc", label: "No, and tell Claude what to do differently" },
  ]);
});

const FINGERPRINT_DIALOG = [
  "⏺ Bash(rm -rf -- /tmp/draft)",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "  Esc to cancel · Tab to amend",
];

test("dialogFingerprint survives the spinner but not a changed choice", () => {
  const first = dialogFingerprint(
    [...FINGERPRINT_DIALOG, "✽ Thinking… (12s · ↓ 1.2k tokens)", "  ➜ repo git:(main) ctx:33% Opus 5"].join("\n"),
  );
  const later = dialogFingerprint(
    [...FINGERPRINT_DIALOG, "✽ Determining… (58s · ↓ 9.9k tokens)", "  ➜ repo git:(main) ctx:41% Opus 5"].join("\n"),
  );
  assert.equal(typeof first, "string");
  assert.equal(first.length, 16);
  assert.equal(first, later, "only the dialog region is hashed");

  const relabelled = [...FINGERPRINT_DIALOG];
  relabelled[4] = "    2. No, and tell Claude what to do differently";
  assert.notEqual(dialogFingerprint(relabelled.join("\n")), first);

  const requestioned = [...FINGERPRINT_DIALOG];
  requestioned[2] = "  Do you want to delete the branch?";
  assert.notEqual(dialogFingerprint(requestioned.join("\n")), first);

  assert.equal(dialogFingerprint("⏺ nothing is being asked here\n"), undefined);
  assert.equal(dialogFingerprint(""), undefined);
});

test("two approvals that differ only in the command hash differently", () => {
  // Claude Code asks the same question with the same choices for every Bash
  // call: if the body is not hashed, a tap meant for the draft deletion is
  // accepted for the force-push that replaced it.
  const draft = dialogFingerprint(FINGERPRINT_DIALOG.join("\n"));
  const forced = [...FINGERPRINT_DIALOG];
  forced[0] = "⏺ Bash(git push --force)";
  assert.notEqual(dialogFingerprint(forced.join("\n")), draft);
});

test("moving the selection marker between options does not change the dialog", () => {
  // Arrowing down redraws the same question with ❯ on another line. The options
  // are already hashed as key|label, so the body must be hashed without them —
  // otherwise merely looking at choice 2 would invalidate the ping.
  const first = dialogFingerprint(FINGERPRINT_DIALOG.join("\n"));
  const moved = [...FINGERPRINT_DIALOG];
  moved[3] = "    1. Yes";
  moved[4] = "  ❯ 2. No";
  assert.equal(dialogFingerprint(moved.join("\n")), first);

  // And a re-wrapped option (same text, different line breaks) is still it.
  const rewrapped = [...FINGERPRINT_DIALOG];
  rewrapped[3] = "  ❯ 1.  Yes";
  assert.equal(dialogFingerprint(rewrapped.join("\n")), first);
});

test("decideBlockedReal trusts herdr only when a hook owns detection", () => {
  assert.equal(
    decideBlockedReal({ screenLive: true, detectionSkipped: undefined, stillBlocked: false }),
    "screen",
  );
  assert.equal(
    decideBlockedReal({ screenLive: false, detectionSkipped: true, stillBlocked: true }),
    "hook-authoritative",
  );
  // The integration owns the state but says the pane moved on.
  assert.equal(decideBlockedReal({ screenLive: false, detectionSkipped: true, stillBlocked: false }), false);
  // Screen-detected agents keep the old, stricter rule.
  assert.equal(decideBlockedReal({ screenLive: false, detectionSkipped: false, stillBlocked: true }), false);
  // Older herdr has no such field, and undefined must not read as true.
  assert.equal(decideBlockedReal({ screenLive: false, detectionSkipped: undefined, stillBlocked: true }), false);
});

test("a blank screen is never evidence of a block", () => {
  // Codex clears the pane the moment a dialog is answered and herdr can still
  // emit `blocked` into that gap. After the retries in readScreenSettled an
  // empty pane is a redraw or a dead pane, and an empty panel helps nobody —
  // so herdr's own status no longer rescues it.
  assert.equal(decideBlockedReal({ screenReadable: false, liveStatus: "blocked" }), false);
  assert.equal(decideBlockedReal({ screenReadable: false, liveStatus: undefined }), false);
  assert.equal(decideBlockedReal({ screenReadable: false, liveStatus: "working" }), false);
});

test("a blank pane read is retried before it is believed", async () => {
  const sleeps = [];
  const wait = async (ms) => {
    sleeps.push(ms);
  };

  const screens = ["", "   ", "Do you want to proceed?"];
  let reads = 0;
  const settled = await readScreenSettled(() => screens[reads++], { delayMs: 500, sleep: wait });
  assert.equal(settled, "Do you want to proceed?");
  assert.equal(reads, 3, "stops as soon as the pane has drawn something");
  assert.deepEqual(sleeps, [500, 500], "waits between blank reads, not after the good one");

  sleeps.length = 0;
  let blanks = 0;
  const empty = await readScreenSettled(
    () => {
      blanks++;
      return "";
    },
    { attempts: 4, delayMs: 250, sleep: wait },
  );
  assert.equal(empty, "");
  assert.equal(blanks, 4);
  assert.deepEqual(sleeps, [250, 250, 250], "no trailing sleep once the attempts run out");

  sleeps.length = 0;
  assert.equal(await readScreenSettled(() => "up", { sleep: wait }), "up");
  assert.deepEqual(sleeps, [], "a pane that reads cleanly costs nothing");
});

test("a done read waits for a turn, not merely for ink on the pane", async () => {
  // A done event lands as the agent repaints, and it repaints from the bottom:
  // the prompt box and the mode footer are there before the turn above them.
  // Such a read is not blank, so the gate that settles `blocked` hands it
  // straight back — and the ping carries nothing. This is the gate the done
  // path uses instead.
  const sleeps = [];
  const wait = async (ms) => {
    sleeps.push(ms);
  };
  const rule = "─".repeat(60);
  const repainting = [rule, "❯ ", rule, "  ⏵⏵ accept edits on · 1 monitor · ← 1 agent"].join("\n");
  const finished = ["⏺ 继续等待。", "", repainting].join("\n");

  const screens = ["", repainting, finished];
  let reads = 0;
  const settled = await readScreenSettled(() => screens[reads++], {
    delayMs: 500,
    sleep: wait,
    ready: (text) => Boolean(doneSnippet(text)),
  });
  assert.equal(doneSnippet(settled), "⏺ 继续等待。");
  assert.equal(reads, 3, "the chrome-only read is not good enough to stop on");
  assert.deepEqual(sleeps, [500, 500]);

  // The blank gate would have stopped on that same read and reported nothing.
  assert.equal(doneSnippet(await readScreenSettled(() => repainting, { sleep: wait })), "");
});

test("consecutiveGate needs the same answer twice in a row", () => {
  const gate = consecutiveGate(2);
  assert.equal(gate.observe(true), false, "one poll can land mid-redraw");
  assert.equal(gate.observe(true), true);
  const reset = consecutiveGate(2);
  assert.equal(reset.observe(true), false);
  assert.equal(reset.observe(false), false, "a disagreeing tick starts the count over");
  assert.equal(reset.observe(true), false);
  assert.equal(reset.observe(true), true);
});

test("dialogChoices gives a hook-authoritative block no buttons at all", () => {
  const menu = [
    "⏺ Bash(rm -rf -- /tmp/draft)",
    "",
    "  Do you want to proceed?",
    "  ❯ 1. Yes",
    "    2. No",
    "",
    "  Esc to cancel",
  ].join("\n");
  assert.deepEqual(
    dialogChoices(menu).map((option) => option.send),
    ["1", "2"],
  );
  assert.deepEqual(dialogChoices(menu, { hookAuthoritative: true }), []);
  // The y/n fallback is the dangerous one: a printed "(y/n)" with no dialog on
  // screen would otherwise put Yes/No on the panel of an agent taking free text.
  const printed = "hook-owned agent is waiting\nit mentioned (y/n) earlier in its output\n";
  assert.equal(dialogChoices(printed).length, 2);
  assert.deepEqual(dialogChoices(printed, { hookAuthoritative: true }), []);
});

test("agentDetectionSkipped reads the hook-owned flag from either herdr shape", () => {
  assert.equal(extractDetectionSkipped({ result: { agent: { screen_detection_skipped: true } } }), true);
  assert.equal(extractDetectionSkipped({ screen_detection_skipped: false }), false);
  assert.equal(extractDetectionSkipped({ result: { agent: { agent_status: "blocked" } } }), undefined);
  assert.equal(extractDetectionSkipped(undefined), undefined);

  const got = JSON.stringify({ result: { agent: { pane_id: "wP:p1", screen_detection_skipped: true } } });
  const listed = JSON.stringify({
    result: {
      agents: [
        { pane_id: "wX:p1", screen_detection_skipped: false },
        { pane_id: "wP:p1", screen_detection_skipped: true },
      ],
    },
  });
  assert.equal(
    agentDetectionSkipped("wP:p1", (args) =>
      args[1] === "get" ? { status: 0, stdout: got } : { status: 1, stdout: "" },
    ),
    true,
  );
  // Older herdr prints usage instead of JSON for `agent get`; the list still has it.
  assert.equal(
    agentDetectionSkipped("wP:p1", (args) =>
      args[1] === "list"
        ? { status: 0, stdout: listed }
        : { status: 0, stdout: "usage: herdr agent get <target>" },
    ),
    true,
  );
  assert.equal(
    agentDetectionSkipped("wX:p1", (args) =>
      args[1] === "list" ? { status: 0, stdout: listed } : { status: 1, stdout: "" },
    ),
    false,
  );
  assert.equal(agentDetectionSkipped("wP:p1", () => ({ status: 1, stdout: "", stderr: "boom" })), undefined);
  assert.equal(agentDetectionSkipped(undefined, () => ({ status: 0, stdout: got })), undefined);
});

// A real Claude Code screen, captured from <state>/last-skipped-screen.txt after
// the panel stopped opening for a pane that had a todo list. The dialog is live
// and the choices are right there, but the task rows drawn under the prompt box
// made every check that walks up from the bottom give up.
const TODO_PANEL_DIALOG = `
⏺ Listing 2 directories, running 5 shell commands…
  ⎿  $ export PATH="$(dirname "$(which node)"):$PATH";
     OPENCLAW_DECK_RENDERER_NODE_PATH=/tmp/deck-renderer-node/node_modules
     OPENCLAW_DATABASE_URL="sqlite+aiosqlite:///:memory:" ./.venv/bin/python -m pytest
     tests/ -q 2>&1 | tail -6

──────────────────────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

   │ export PATH="$(dirname "$(which node)"):$PATH";
   │ OPENCLAW_DECK_RENDERER_NODE_PATH=/tmp/deck-renderer-node/node_modules
   │ OPENCLAW_DATABASE_URL="sqlite+aiosqlite:///:memory:" ./.venv/bin/python -m pytest
   │ tests/ -q 2>&1 | tail -6
   Run tests/ with real node_modules

 Contains shell syntax (string) that cannot be statically analyzed

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and switch to auto mode · auto mode handles these prompts for you
   3. No

 Esc to cancel · Tab to amend

  4 tasks (3 done, 1 in progress, 0 open)
  ✔ 拆出 DeckSpecAuthor 独立写稿调用
  ✔ build_slides_deck 改收 brief，修复轮移进工具内部
  ✔ 回退主 agent 的 effort/预算与契约注入
  ◼ 回归测试 + 重新实测端到端`;

test("a task list under the prompt box does not hide the dialog above it", () => {
  assert.equal(screenHasLiveDialog(TODO_PANEL_DIALOG), true);
  assert.deepEqual(
    parseBlockedOptions(TODO_PANEL_DIALOG).map((option) => `${option.key}:${option.send}:${option.label}`),
    [
      "1:1:Yes",
      "2:2:Yes, and switch to auto mode · auto mode handles these prompts for you",
      "3:3:No",
    ],
  );
  const snippet = blockedSnippet(TODO_PANEL_DIALOG);
  // The tool call and the reason come with the question, and none of the task
  // rows do.
  assert.match(snippet, /Bash command/);
  assert.match(snippet, /Contains shell syntax/);
  assert.match(snippet, /Do you want to proceed\?/);
  assert.doesNotMatch(snippet, /4 tasks/);
  assert.doesNotMatch(snippet, /回归测试/);
});

// A real Claude Code multi-question form, captured live from a pane that had
// gone `blocked`. Two things about it broke the parser at once: a drawn rule
// splits the choice list ("Chat about this" lives in its own section under the
// divider) and the question ends in a fullwidth `？`. Together they left one
// useless button, "Chat about this", and a snippet with no question in it.
const TABBED_FORM = `⏺ 探索完毕。当前 /ws/v2/simple_transcribe 走的是 resolveProviderStrict(language, diarization)，只按「语言候选 +
  asr.default-provider」选供应商，完全没有医院维度。有几个语义决策需要你确认：
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ 参数名  ☒ 优先级  ☐ 私有化供应商  ☐ 透传范围  ✔ Submit  →

│ 医院配置为私有化供应商 70000201_asr（不在任何语言的 providers 列表里）时如何处理？

❯ 1. 直接透传，跳过语言路由（推荐）
     与现有 resolveProvider 的私有化白名单行为一致，院内数据不会被路由到公有云供应商；若该语言/话者分离不支持，由识别器自身报错
  2. 按普通供应商处理
     不在语言候选内就回退到公有云供应商（tencent/xunfei），语言能力校验更严格，但院内医院的音频会出院
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

test("a rule inside the choice list does not cut the run short", () => {
  assert.deepEqual(
    parseBlockedOptions(TABBED_FORM).map((option) => `${option.key}:${option.send}`),
    ["1:1", "2:2", "3:3", "4:4"],
  );
});

test("a question ending in a fullwidth mark is still the question", () => {
  const snippet = blockedSnippet(TABBED_FORM);
  assert.match(snippet, /医院配置为私有化供应商.*时如何处理？/);
  // The tab bar rides along, and it is the only thing on screen that says which
  // of the four questions this is.
  assert.match(snippet, /☒ 参数名/);
  assert.match(snippet, /☐ 透传范围/);
  assert.equal(screenHasLiveDialog(TABBED_FORM), true);
});

// Constructed, not captured: the Codex shape, where the command sits *below*
// the question, is what makes finding the question matter — the region starts
// at it instead of walking up into the tool call. With an ASCII-only test for
// the question mark, a Chinese question is never found and the block starts in
// the wrong place.
const FULLWIDTH_QUESTION = [
  "⏺ Bash(rm -rf -- /tmp/draft)",
  "",
  "是否允许执行该命令？",
  "",
  "Environment: production",
  "Command: rm -rf -- /tmp/draft",
  "",
  "1. 允许",
  "2. 拒绝",
  "",
  "Esc to cancel",
].join("\n");

test("a fullwidth question anchors the block the way an ASCII one does", () => {
  const snippet = blockedSnippet(FULLWIDTH_QUESTION);
  assert.ok(snippet.startsWith("是否允许执行该命令？"), snippet);
  assert.match(snippet, /Command: rm -rf/);
  assert.doesNotMatch(snippet, /⏺ Bash/);
  assert.deepEqual(
    parseBlockedOptions(FULLWIDTH_QUESTION).map((option) => option.label),
    ["允许", "拒绝"],
  );
});

// Reconstructed from a screenshot of a real pane (the form had already been
// answered by the time it could be read back). What matters is verbatim: two
// option descriptions mention "token", and the footer heuristic used to treat
// any short line containing that word as chrome — so the walk up the choice
// list stopped at the first one and the ping went out with options 1 and 2
// missing, which is what the panel showed.
const TOKEN_IN_OPTION_TEXT = `⏺ 分支已拉好（ai-assistant 现在在 feature_TRZN-7298，基于最新 origin/master 075235fa，你本地改的两个配置文件原样保留）。代码分析完了，有几个决策点需要你定：
────────────────────────────────────────────────────────────────────────────────
←  ☐ APP 鉴权  ☐ asr 侧收紧  ☐ 返回内容  ☐ hospital_code  ✔ Submit  →

ai-assistant 新增的对外取 token 接口用什么鉴权？

› 1. @CheckDoctorTokenParam（推荐）
     复用现有 AOP，只校验 Authorization 里的医生登录 token，不需要请求体。DoctorFileController 等已在用这个注解
  2. 不鉴权
     不加鉴权，任何人可从 ai-assistant 取到 ASR token。等于把 asr-service 现在的开放状态原样搬过来
  3. 另设签名机制
     另起一套（如 APP 端专用 appKey/签名），需要新增鉴权代码
  4. Type something.
────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

test("an option that mentions tokens is not mistaken for the footer", () => {
  assert.deepEqual(
    parseBlockedOptions(TOKEN_IN_OPTION_TEXT).map((option) => option.key),
    ["1", "2", "3", "4", "5"],
  );
  const snippet = blockedSnippet(TOKEN_IN_OPTION_TEXT);
  assert.match(snippet, /@CheckDoctorTokenParam/);
  assert.match(snippet, /不鉴权/);
});

test("a real spinner footer still counts as chrome", () => {
  // The shape the heuristic exists for: the count is what makes it a footer.
  const withFooter = [
    "Do you want to proceed?",
    "",
    "1. Yes",
    "2. No",
    "",
    "✢ Canoodling… (7m 52s · ↓ 17.3k tokens · thinking with xhigh effort)",
  ].join("\n");
  assert.equal(screenHasLiveDialog(withFooter), true);
  assert.doesNotMatch(blockedSnippet(withFooter), /Canoodling/);
});

// Captured live from a pane Herdr reported `done`, and then `idle`, while this
// form sat on it waiting: no blocked event ever came, so the only panel that
// opened was a done panel, showing the form as text with nothing to press. The
// cursor has moved to choice 2 — the user was already reaching for it.
const FORM_HERDR_CALLED_DONE = `⏺ Before changing anything, confirming that clinmate.trizenai.com really is the domestic Supabase address. My notes have it as the domestic app site, so checking the domestic
  build config committed in the repo:

  Searched for 2 patterns, ran 1 shell command
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ 切换方式  ☐ 发布保护  ✔ Submit  →

Worker 的 Supabase 配置怎么切？

  1. 另建境内配置文件 (Recommended)
     新建 deploy/cloudflare/.env.workers.selfhost.local 指向境内库，默认配置仍指向 Cloud。割接当天用 --env-file 指定它发布；数据同步和 GoTrue
     配好之前，误发布也不会把生产切走。
❯ 2. 直接改默认配置
     直接修改 deploy/cloudflare/.env.workers.local（先备份），之后任何一次 Workers 发布都会立刻把生产切到境内库。
  3. Type something.
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── deploy-version-display ─`;

test("a form herdr called done is an open menu", () => {
  assert.equal(screenHasOpenMenu(FORM_HERDR_CALLED_DONE), true);
  assert.deepEqual(
    parseBlockedOptions(FORM_HERDR_CALLED_DONE).map((option) => option.send),
    ["1", "2", "3", "4"],
  );
  assert.match(blockedSnippet(FORM_HERDR_CALLED_DONE), /Worker 的 Supabase 配置怎么切？/);
  // The forms captured from panes that did go `blocked` pass the same check.
  assert.equal(screenHasOpenMenu(TABBED_FORM), true);
  assert.equal(screenHasOpenMenu(TOKEN_IN_OPTION_TEXT), true);
});

test("a turn that ends on a numbered question is not an open menu", () => {
  // Nothing but the empty prompt box and its footer under the list, which is
  // exactly what sits under a real dialog — so the liveness check alone calls
  // it live, and a `done` promoted on that would put the agent's prose on
  // buttons. No cursor on any choice is what gives it away.
  const proseEnding = [
    "⏺ Two ways to do the cutover:",
    "",
    "  1. Add a separate config file for the domestic database",
    "  2. Edit the default config in place",
    "",
    "  Which one do you want?",
    "",
    "────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────",
    "  ⏵⏵ accept edits on · 1 monitor · ← 1 agent",
  ].join("\n");
  assert.equal(screenHasOpenMenu(proseEnding), false);

  const listLast = [
    "⏺ Which one do you want?",
    "",
    "  1. Add a separate config file",
    "  2. Edit the default config in place",
    "",
    "────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────",
    "  ➜ repo git:(main) ctx:33% Opus 5",
  ].join("\n");
  assert.equal(screenHasLiveDialog(listLast), true);
  assert.equal(screenHasOpenMenu(listLast), false);
});

test("a numbered draft in the prompt box is not an open menu", () => {
  const draft = [
    "⏺ Done. All 42 tests pass.",
    "",
    "────────────────────────────────────────",
    "❯ 1. now bump the version",
    "────────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
  ].join("\n");
  assert.equal(screenHasOpenMenu(draft), false);
});

// A multi-question form advances in place: the status never leaves `blocked`,
// so Herdr sends no second event and the panel has to find the next question
// itself.
function formTab(question, first, second) {
  return [
    "←  ☒ 参数名  ☐ 透传范围  ✔ Submit  →",
    "",
    question,
    "",
    `❯ 1. ${first}`,
    `  2. ${second}`,
    "",
    "Enter to select · Esc to cancel",
  ].join("\n");
}

test("the panel follows a form to the question that replaces the one answered", async () => {
  const one = formTab("参数名用哪个？", "hospital_code", "hospitalCode");
  const two = formTab("透传范围到哪一层？", "只到网关", "一路透传");
  const answered = dialogFingerprint(one);
  const seen = [one, one, two];
  let reads = 0;
  const slept = [];
  const next = await nextDialog({
    read: () => seen[Math.min(reads++, seen.length - 1)],
    status: () => "blocked",
    answered,
    wait: async (ms) => slept.push(ms),
  });
  assert.equal(next.fingerprint, dialogFingerprint(two));
  assert.match(next.screen, /透传范围到哪一层/);
  // It waited out the two reads that still showed the answered question.
  assert.equal(slept.length, 3);
});

test("a form that ends gives up instead of reopening the panel", async () => {
  const one = formTab("参数名用哪个？", "hospital_code", "hospitalCode");
  // Submitted: the dialog is gone and the agent is working again.
  const next = await nextDialog({
    read: () => "⏺ Running tests…\n\n  ⎿  $ pytest -q",
    status: () => "working",
    answered: dialogFingerprint(one),
    wait: async () => {},
  });
  assert.equal(next, undefined);
});

test("a screen that never changes runs out of attempts rather than looping", async () => {
  const one = formTab("参数名用哪个？", "hospital_code", "hospitalCode");
  let reads = 0;
  const next = await nextDialog({
    read: () => {
      reads++;
      return one;
    },
    status: () => "blocked",
    answered: dialogFingerprint(one),
    attempts: 4,
    wait: async () => {},
  });
  assert.equal(next, undefined);
  assert.equal(reads, 4);
});

test("a blank read mid-redraw does not end the follow-on", async () => {
  const two = formTab("透传范围到哪一层？", "只到网关", "一路透传");
  const seen = ["", "   ", two];
  let reads = 0;
  const next = await nextDialog({
    read: () => seen[Math.min(reads++, seen.length - 1)],
    // Herdr's detection lags the redraw and briefly reports nothing at all.
    status: () => undefined,
    answered: "an-older-fingerprint",
    wait: async () => {},
  });
  assert.equal(next.fingerprint, dialogFingerprint(two));
});
