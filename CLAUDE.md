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
2. **Poller** — `src/hooks/poll.mjs`. Long-running, detached child (`src/inbound/poller.mjs` spawns it via `run-node.sh`, pid in `<state>/poller.pid`). Long-polls Telegram `getUpdates` and handles pairing + replies. It is started by `seed.mjs` at build/startup, and `notify.mjs` calls `ensurePoller()` on every event as a self-heal. Any action that touches config calls `restartPoller()`.
3. **Actions** — `src/actions/*.mjs`. One-shot CLI scripts (setup/install, poll, pair, test, toggle, seed).

### Two on-disk directories (never confuse them)

- **Config dir** — where `.env` lives. Resolved by `configDirPath()` in `src/lib/paths.mjs`: `HERDR_PLUGIN_CONFIG_DIR` → `herdr plugin config-dir <id>` → XDG fallback. `seedConfigEnv()` copies `.env.example` there and non-destructively upgrades missing keys (`NOTIFY_ON`, `BLOCKED_DELAY_SEC`). `.env` survives reinstalls.
- **State dir** — `HERDR_PLUGIN_STATE_DIR` → `~/.local/state/herdr-oncall`. Holds runtime files: `enabled` (toggle), `last-notify.json` (debounce), `blocked-delay.json` (delayed-ping ownership), `outbound.json` (Telegram message_id → pane map, 24h TTL), `telegram-offset`, `poller.pid`, `pair.json`, `panels.json` (pane → open panel pid), `node-path`. In practice Herdr passes `~/.local/state/herdr/plugins/<id>` to events and actions and nothing to build commands, so build-time and runtime processes see different state dirs.

Tests isolate themselves by pointing these two env vars at `mkdtempSync` dirs; follow that pattern for any new test that touches disk.

### Outbound flow (notify.mjs)

`resolveStatus` → `resolveWorktree` (fills `context.worktree` from `herdr workspace get` and the branch from `herdr worktree list --workspace` when the event did not carry them) → then:

- **blocked, panel available, `BLOCKED_DELAY_SEC` > 0**: `showPanel` replaces the wait. A button or typed text goes straight into the pane via `deliverReply` and the hook exits without Telegram. Timeout or Esc falls through to the checks below and then Telegram. While the panel is up, `until` is polled every 2s: the pane leaving `blocked` (answered in Herdr) closes it and the hook exits; the user arriving at the pane (`userAtPane`: Herdr focused pane + terminal app frontmost via `lsappinfo`) closes it and the remaining delay runs silently before Telegram. The panel is not opened at all when the user is already at the pane. A newer blocked event for the same pane kills the older panel (`panels.json`) and the older hook exits as `superseded`.
- **blocked otherwise**: wait `BLOCKED_DELAY_SEC`, then bail unless this pane's delay is still ours (`blockedDelayStillMine`) **and** `herdr pane get` still says blocked.
- Telegram send: `shouldDebounce` → `readPaneScreen` (`herdr pane read`; `recent-unwrapped` source for done, `visible` for blocked) → `blockedSnippet`/`doneSnippet` + `parseBlockedOptions` (`src/lib/format.mjs`) → `sendTelegram` (inline keyboard for blocked options, else force-reply) → `rememberOutbound(messageId → paneId)`.
- **done**: Telegram is pinged first, then the panel opens with the last turn and a text field; typed text becomes a new prompt.

The panel binary speaks a one-line stdout protocol (`button:<i>` / `text:<t>` / `timeout` / `dismiss`), parsed by `parsePanelResult` in `src/lib/desktop.mjs`. Panel debounce uses the keys `panel:blocked` / `panel:done` so it does not interfere with the Telegram debounce. `blockedSnippet` handles two dialog shapes: Claude Code puts the `⏺ Tool(...)` line and arguments **above** "Do you want to proceed?" with options right under it, Codex puts the question first and the command under it; it walks up to the tool line in the first case and cuts the tail at the first chrome/prompt line after the options in both.

### Inbound flow (reply.mjs)

`handleTelegramUpdate` → pairing check (`/start CODE` or bare code while `pair.json` is pending; writes `TELEGRAM_CHAT_ID` via `upsertEnvValue`) → reject any chat other than `TELEGRAM_CHAT_ID` → `resolveReplyTarget` (the `reply_to_message` id looked up in `outbound.json`, else the most recent outbound) → `deliverReply`, which re-reads the **live** pane status and classifies:

| live status | reply text | herdr command |
|---|---|---|
| blocked | single key / named key (`y`, `esc`, `enter`…) | `pane send-keys` |
| blocked | anything else | `pane send-text` + `send-keys enter` |
| other | anything | `agent prompt` (falls back to send-text on `agent_blocked`) |

Inline-keyboard taps arrive as `callback_query` and take the same `finishDelivery` path.

### Talking to Herdr

All Herdr calls go through `runHerdr()` (`spawnSync` of `HERDR_BIN_PATH` or `herdr`). Herdr's JSON shapes are not stable, so `extractAgentStatus` and `extractReadText` in `src/lib/herdr.mjs` probe several nestings, and `readPaneScreen` tries a list of command variants in order. When adding a new Herdr call, follow the same defensive pattern rather than assuming one shape.

`src/lib/index.mjs` re-exports every lib module; import from it (`../lib/index.mjs`) rather than from individual files.

## Conventions and non-goals

- The plugin id is fixed at `com.codreamer.herdr.oncall`. Do not create `oncall.telegram` / `oncall.app` variants; new channels are a `CHANNEL` value, not a new plugin. `OLD_PLUGIN_IDS` in `paths.mjs` exists only so install can unlink legacy ids.
- Telegram messages are plain text, no emoji (a test asserts this), no Markdown parse mode.
- The location line (`formatWhere`) is `repo · worktree <name> (<branch>) · space · tab · pane N`; the worktree segment appears only for linked worktrees (`is_linked_worktree`), and the space is dropped when it just repeats the repo or worktree name.
- Never send the full pane transcript: blocked → dialog tail, done → last assistant turn only.
- Only `TELEGRAM_CHAT_ID` may drive panes; keep the chat check in both the message and callback paths.
- Scripts that fail exit `0` when the plugin is simply unconfigured or disabled (so Herdr doesn't log noise) and non-zero only for real errors.
