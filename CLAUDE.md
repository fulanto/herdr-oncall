# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [Herdr](https://github.com/ogulcancelik/herdr-plugin-examples) plugin (`com.codreamer.herdr.oncall`) that pings Telegram when an agent pane goes `blocked` or `done`, and delivers Telegram replies back into that pane. On macOS a floating desktop panel (`src/desktop/panel.swift`) comes first and Telegram is the fallback. Plain ESM Node.js (`.mjs`), Node 18+, **no package.json and no npm dependencies** — only `node:` builtins and global `fetch`. The plugin manifest is `herdr-plugin.toml`; bump `version` there for releases.

## Commands

```sh
# run all tests (node's built-in runner; `node --test test/` with a bare dir path does NOT work)
node --test 'test/*.test.mjs'

# one file / one test by name
node --test test/pair.test.mjs
node --test --test-name-pattern="pairDeepLink" test/pair.test.mjs
```

There is no lint or build step for the JS. The macOS panel is compiled by `bin/install-deps.sh` (Herdr's `[[build]]` step) with `swiftc` into `bin/oncall-panel` (git-ignored); to rebuild after editing `panel.swift`, run `bash bin/install-deps.sh` (about a minute). It lives in the plugin root rather than the state dir because Herdr sets `HERDR_PLUGIN_STATE_DIR` for events and actions but **not** for build commands, so anything the build writes to "the state dir" lands somewhere the hooks never look. Live testing goes through the Herdr CLI (see README): `herdr plugin action invoke <setup|poll|pair|test|toggle|enable|disable> --plugin com.codreamer.herdr.oncall`, then `herdr plugin log list --plugin com.codreamer.herdr.oncall --limit 5` for real output (`action invoke` only returns JSON immediately). `bash install.sh` links the checkout into Herdr for local development.

To exercise the notify hook by hand without pinging Telegram, run it with an empty token and a short delay against a real pane:

```sh
TELEGRAM_BOT_TOKEN= BLOCKED_DELAY_SEC=5 \
HERDR_PLUGIN_EVENT_JSON='{"data":{"pane_id":"wJ:p1","agent_status":"blocked","display_agent":"codex"}}' \
bash bin/run-node.sh src/hooks/notify.mjs
```

## Architecture

### Process model

Every entry point in `herdr-plugin.toml` runs through `bin/run-node.sh`, because Herdr's server does not have a login-shell PATH. The script hunts for `node` (nvm/fnm/mise/volta/homebrew…), caches the path in `<state>/node-path`, and `exec`s it. If something "can't find node", look there first.

Three kinds of process share `src/lib`:

1. **Event hook** — `src/hooks/notify.mjs`. One-shot, spawned by Herdr on `pane.agent_status_changed`. Reads `HERDR_PLUGIN_EVENT_JSON` / `HERDR_PLUGIN_CONTEXT_JSON` from env. Outbound path only.
2. **Poller** — `src/hooks/poll.mjs`. Long-running, detached child (`src/inbound/poller.mjs` spawns it via `run-node.sh`, pid in `<state>/poller.pid`). Long-polls Telegram `getUpdates` and handles pairing + replies. It is started by `seed.mjs` at build/startup, and `notify.mjs` calls `ensurePoller()` on every event as a self-heal. Any action that touches config calls `restartPoller()`. Its stdout and stderr go to `<state>/poller.log`, timestamped by `withTimestamps()` and rotated once at 256 KB — nothing else captures them, since Herdr's plugin log only sees the action that spawned it and that action exits immediately.
3. **Actions** — `src/actions/*.mjs`. One-shot CLI scripts (setup/install, poll, pair, test, toggle, seed).

### Two on-disk directories (never confuse them)

- **Config dir** — where `.env` lives. Resolved by `configDirPath()` in `src/lib/paths.mjs`: `HERDR_PLUGIN_CONFIG_DIR` → `herdr plugin config-dir <id>` → XDG fallback. `seedConfigEnv()` copies `.env.example` there and non-destructively upgrades missing keys (`NOTIFY_ON`, `BLOCKED_DELAY_SEC`). `.env` survives reinstalls.
- **State dir** — `stateDir()` in `src/lib/paths.mjs`: `HERDR_PLUGIN_STATE_DIR` → Herdr's own `<state home>/herdr/plugins/<id>` when that directory exists (`herdr-dev` for a debug build) → `<state home>/herdr-oncall` for a machine where Herdr has never linked the plugin. Holds runtime files: `enabled` (toggle), `last-notify.json` (debounce), `blocked-delay.json` (delayed-ping ownership), `outbound.json` (Telegram message_id → pane map, 24h TTL), `telegram-offset`, `poller.pid`, `poller.log` (+ `poller.log.1`), `pair.json`, `panels.json` (pane → open panel pid), `last-skipped-screen.txt` (the screen behind the most recent `skipped` line, to turn into a fixture), `node-path`.

  Herdr sets `HERDR_PLUGIN_STATE_DIR` for events and actions, but **not** for build commands and not for anything you run from a shell — `install.sh` included. Computing Herdr's own path for those cases is not cosmetic: while the fallback was a second directory, a shell-run process and a Herdr-run hook kept separate `poller.pid` files, so `ensurePoller()` could not see the other side's poller. Five of them ended up long-polling one bot token (Telegram allows one, the rest get 409 Conflict), and a stray one that won an update had no `outbound.json` to resolve the pane with, so the reply answered "Reply to a ping so I know which pane." `bin/run-node.sh` is bash and still caches `node-path` under the old path; that one is only a cache, so it re-derives instead of splitting anything.

Tests isolate themselves by pointing these two env vars at `mkdtempSync` dirs; follow that pattern for any new test that touches disk.

### Outbound flow (notify.mjs)

`resolveStatus` → `resolveWorktree` (fills `context.worktree` from `herdr workspace get` and the branch from `herdr worktree list --workspace` when the event did not carry them) → then:

- **blocked, first gate**: read the pane through `readScreenSettled` (up to 6 tries, 500 ms apart, first non-blank read wins) and require `screenHasLiveDialog`. Herdr's `blocked` is not trustworthy on its own — its detector matches dialog wording anywhere in the recent buffer, so an agent that merely *printed* a permission prompt pins its own pane at blocked (this repo did exactly that to itself while building the parser), and `herdr pane get` can also hand back a stale value from the previous detection pass. No live dialog on screen → log `skipped · … · blocked but no dialog on screen · tail: …` (the last 8 non-blank lines) and write the whole screen to `<state>/last-skipped-screen.txt`, so an unrecognised shape becomes a fixture instead of a silent drop. A screen that is still blank after those retries is never evidence of anything: `decideBlockedReal({ screenReadable: false })` is `false` whatever `herdr pane get` says, and the skip reads `blocked but pane screen empty`. Codex clears and redraws the pane the instant a dialog is answered, and trusting the status through that gap is what opened an empty panel with no body and no buttons.
  The exception is an agent whose lifecycle an integration owns (Herdr 0.9.0: Pi, OMP, Kimi Code, OpenCode, Kilo, MastraCode). `agentDetectionSkipped(paneId)` reads `screen_detection_skipped`; when it is true and `stillBlocked()` agrees, `decideBlockedReal` (pure, in `src/lib/herdr.mjs`) calls the block real even with no menu drawn — logged as `hook-authoritative · <where>`. That ping carries no inline keyboard and no fingerprint — and neither does the desktop panel, since both take their buttons from `dialogChoices(screen, { hookAuthoritative })`, the one gate that keeps the `(y/n)` fallback off an agent with no menu drawn — and `paneMovedOn` watches the status instead of the screen. The `agent get` call is made once per hook process, not on every panel poll.

- **blocked, panel available, `BLOCKED_DELAY_SEC` > 0**: `showPanel` replaces the wait. A button or typed text goes straight into the pane via `deliverReply` and the hook exits without Telegram. Timeout or Esc falls through to the checks below and then Telegram. While the panel is up, `until` is polled every 2s: the dialog leaving the screen (answered in Herdr) closes it and the hook exits; the user arriving at the pane (`userAtPane`: Herdr focused pane + terminal app frontmost via `lsappinfo`) closes it and the remaining delay runs silently before Telegram. "The dialog is gone" needs two consecutive polls (`consecutiveGate` in `src/lib/desktop.mjs`) and a blank read counts as neither — one tick can land mid-redraw. The panel is not opened at all when the user is already at the pane. A newer blocked event for the same pane kills the older panel (`panels.json`) and the older hook exits as `superseded`.
- **blocked, after the wait**: re-read the pane with `readScreenSettled` and require a live dialog again (not `herdr pane get`), plus `blockedDelayStillMine`.
- Telegram send: `shouldDebounce` → `readPaneScreen` (`herdr pane read`; `recent-unwrapped` source for done, `visible` for blocked) → `blockedSnippet`/`doneSnippet` + `parseBlockedOptions` (`src/lib/format.mjs`) → `sendTelegram` (inline keyboard for blocked options, else force-reply) → `rememberOutbound(messageId → pane)`, which also stores the dialog's `fingerprint` and parsed `options`.
- **done**: Telegram is pinged first, then the panel opens with the last turn and a text field; typed text becomes a new prompt.

The panel binary speaks a one-line stdout protocol (`button:<i>` / `text:<t>` / `timeout` / `dismiss`), parsed by `parsePanelResult` in `src/lib/desktop.mjs`. Panel debounce uses the keys `panel:blocked` / `panel:done` so it does not interfere with the Telegram debounce. Opening it calls `NSApp.activate`: an input method attaches to the *active application*, not to whichever window holds the caret, so as a `.nonactivatingPanel` the field took raw keystrokes (fine for `y` or `1`) while the IME stayed with the terminal and Chinese could not be typed at all. Activating makes macOS write input-method chatter to stderr on every open, which `panelStderr` drops so a working panel does not log two errors per notification.

### Reading a permission dialog off the screen (`src/lib/format.mjs`)

`screenLines` keeps blank lines and drawn rules — they are the block boundaries, and the old version that filtered them out is what forced guesswork like "take the last N lines". `dialogRegion` then locates the dialog structurally, and both `blockedSnippet` and `parseBlockedOptions` work from that one region:

- **options**: the run of numbered lines at the *bottom* of the screen, found by skipping the trailing key hints and walking up. Taking the first numbered run below the question instead is what once put a workflow's phase list (`1. Review — three lenses…`) on the buttons and dropped the real `1. Yes, run it` as a duplicate index. A more indented non-numbered line inside the run is a wrapped option, not a boundary. A drawn rule inside the run is crossed only when the line above it continues the numbering downward — Claude Code's tabbed multi-question form puts `4. Chat about this` in its own section under a divider, and stopping at that rule left exactly one useless button.
- **question**: the nearest line above the run that ends in `?` or the fullwidth `？`, stopping at the same structural boundaries as the body walk. Only when there is no numbered run at all (a bare y/n prompt) does it fall back to matching wording (`would you like` / `do you want` / `allow` / `permission`), which is still English-only.
- **start**: if non-blank content sits between the question and the first option, the command is *below* the question (one Codex shape) and the question is the start. Otherwise the content is *above* (Claude Code, Codex "requires approval") and the walk goes up to the first structural boundary: a turn marker (`⏺`/`●`, included — it names the tool), a Codex tool header line, the previous user turn, a drawn rule, or two consecutive blanks. There is deliberately **no line cap**: the input is a single viewport, so the walk is already bounded, and a cap only truncates long commands.
- **render**: `renderBlock` drops rules, trims the edges, and collapses blank runs.
- **shortcuts**: a trailing parenthetical becomes the key to send only when it names one — a single letter or digit, or `esc`/`escape`/`enter`/`return`/`tab`/`space`. Anything else (`(default)`, `(shift+tab)`) stays in the label and the option index is sent instead; the old "alphanumeric and ≤ 8 chars" rule made `1. Yes (default)` type the word `default` into the pane.
- **fingerprint**: `dialogFingerprint` hashes the question, every `key|label`, and the rendered body *above* the first option into 16 hex chars — the body is in there because two Bash approvals in a row ask the identical question with the identical choices and only the command differs, and the option lines are left out of it because they are already hashed as `key|label`, so moving the terminal's `❯` marker between choices (or re-wrapping them) must not invalidate a ping. It is what the inbound path compares against the live screen before pressing a key, and hashing only the region is what keeps it stable while a spinner or footer changes underneath.
- **liveness**: `screenHasLiveDialog` says a dialog is *waiting* rather than merely *quoted* — only blanks, drawn rules and chrome may follow it. Getting `isRuleLine` and `isChromeLine` right matters here: the labelled separators the agents draw (`──── ultracode ↯ ─`), the status footers (`➜ repo git:(main) ctx:33% Opus 5`, `» Ask Codex…`) and Claude Code's task list (`4 tasks (3 done, 1 in progress, 0 open)` and its `✔`/`◼`/`◻` rows) all sit under a real dialog, and treating them as content swallows genuine notifications. The task list cost every pane with a todo the panel *and* its buttons, silently, until the skip trace caught it: both liveness and `trailingOptionRun` find the dialog by walking up from the bottom past the chrome, so one unrecognised footer breaks both.

  The error runs the other way too, and is worse: chrome rules that are too *loose* eat real content. `tokens?` matched any short line mentioning the word, so an option whose description read `任何人可从 ai-assistant 取到 ASR token` ended the walk and the ping went out with the first two choices missing. A footer's token count is what makes it a footer, so the rule requires the number.

Reading the pane goes through Herdr's socket to the server that owns the PTY, so it works regardless of what is on the physical display — the terminal can be minimised, on another Space, or in an unfocused workspace. Only `userAtPane` (which suppresses the panel) depends on the desktop.

When a dialog shape does not extract cleanly, capture the real screen (`herdr pane read <pane> --source visible --format text`) and add it as a test case rather than tuning a threshold.

### Inbound flow (reply.mjs)

`handleTelegramUpdate` → pairing check (`/start CODE` or bare code while `pair.json` is pending; writes `TELEGRAM_CHAT_ID` via `upsertEnvValue`) → reject any chat other than `TELEGRAM_CHAT_ID` → `resolveReplyTarget` (the `reply_to_message` id looked up in `outbound.json`, else the most recent outbound, and the record is tagged `explicit` when the reply named it) → `deliverReply`, which re-reads the **live** pane status and classifies:

| live status | reply text | herdr command |
|---|---|---|
| blocked | single key / named key (`y`, `esc`, `enter`…) | `pane send-keys` |
| blocked | anything else | `pane send-text` + `send-keys enter` |
| other | anything | `agent prompt` (falls back to send-text on `agent_blocked`) |

Before any of that, a reply that carries a `fingerprint` is re-verified: `deliverReply` reads the screen again — **whatever `pane get` says**, because Herdr's status lags and a pane it still calls `working` can already have the next dialog drawn on it — and requires a live dialog whose `dialogFingerprint` still matches. A Telegram button lives forever, the dialog it belonged to does not, and a `1` meant for one prompt must not land on the next one. No live dialog on screen is stale too: the dialog this reply was about is gone. A mismatch returns `{ status: 1, stale: true, … }`, nothing reaches the pane, and the ack is `stale · <where> · dialog changed, not sent`. A pane that cannot be read at all logs `fingerprint unverified · <paneId>` and sends anyway. Which replies carry the fingerprint is `replyFingerprint(target)`: only ones that named their ping — an explicit `reply_to_message` or a button tap — since a **bare** message that merely resolves to the most recent outbound is about the *pane*, not about that dialog, and must still deliver as a prompt. The ping's own status gates it too, so a done record is never fingerprint-checked, and records written before fingerprints existed behave exactly as before. The `agent prompt` → `agent_blocked` fallback runs the same check a second time: Herdr answering `agent_blocked` means `pane get` was stale and a dialog *is* up, so the text must not be typed into it unsighted.

Inline-keyboard taps arrive as `callback_query` and take the same `finishDelivery` path; a tap always names its own message, so an id missing from `outbound.json` is acked with `no pane mapped for that button` rather than falling back to the most recent ping. `handleTelegramUpdate` takes its Telegram and Herdr edges (`send`, `answer`, `run`) from its `deps` argument, defaulting to the real ones, so the whole inbound path is testable without a network or a live pane.

### Talking to Herdr

All Herdr calls go through `runHerdr()` (`spawnSync` of `HERDR_BIN_PATH` or `herdr`). Herdr's JSON shapes are not stable, so `extractAgentStatus` and `extractReadText` in `src/lib/herdr.mjs` probe several nestings, and `readPaneScreen` tries a list of command variants in order. When adding a new Herdr call, follow the same defensive pattern rather than assuming one shape.

`src/lib/index.mjs` re-exports every lib module; import from it (`../lib/index.mjs`) rather than from individual files.

## Conventions and non-goals

- The plugin id is fixed at `com.codreamer.herdr.oncall`. Do not create `oncall.telegram` / `oncall.app` variants; new channels are a `CHANNEL` value, not a new plugin. `OLD_PLUGIN_IDS` in `paths.mjs` exists only so install can unlink legacy ids.
- Telegram messages are plain text, no emoji (a test asserts this), no Markdown parse mode.
- The location line (`formatWhere`) is `repo · task · space · tab · pane N`, and the desktop panel shows it as its heading with `status · Agent` underneath in small grey — which task it is matters more than what state it is in. The *task* segment is a linked worktree's own directory name (branch appended in parens only when it is not the same slug — `build_deploy_plan` vs `build-deploy-plan` counts as the same), or, for an ordinary checkout, the branch — including `main`, which is as much a fact as any other branch. `resolveWorktree` gets all of it from one `herdr worktree list --workspace <id>` call: `workspace get` only carries a `worktree` block for worktree-backed workspaces, so an ordinary repo used to show nothing but its workspace label. The space segment is dropped when it just repeats the repo or the task.
- Never send the full pane transcript: blocked → dialog tail, done → last assistant turn only.
- Only `TELEGRAM_CHAT_ID` may drive panes; keep the chat check in both the message and callback paths.
- Scripts that fail exit `0` when the plugin is simply unconfigured or disabled (so Herdr doesn't log noise) and non-zero only for real errors.
