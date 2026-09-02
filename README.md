# Oncall Telegram

Herdr plugin. **v1 is notify-only:** when an agent becomes `blocked`, ping a Telegram chat. No reply buttons, no `agent prompt`, no App.

Derived from the cookbook example [`ogulcancelik/herdr-plugin-examples/agent-telegram-notify`](https://github.com/ogulcancelik/herdr-plugin-examples/tree/main/agent-telegram-notify) (Herdr 0.7 plugin system). Changes in this first cut:

- default `NOTIFY_ON=blocked` (the example also fired on `done`)
- message includes workspace + pane id (needed for a later reply router)
- 2s debounce per pane+status
- `test` action to send a canned ping

v2 (not in this repo yet): reply to the card → `agent send-keys` if still blocked, `agent prompt` only when idle/working.

## Install

Repo is private. Clone, then link:

```sh
git clone git@github.com:fulanto/herdr-oncall.git
cd herdr-oncall
herdr plugin link .
CONFIG_DIR="$(herdr plugin config-dir oncall.telegram)"
cp .env.example "$CONFIG_DIR/.env"
```

Fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Token stays in the config directory, never in git.

If Herdr can see a public copy later:

```sh
herdr plugin install fulanto/herdr-oncall
```

Requires Node.js 18+, Herdr >= 0.7.0, no npm packages.

## Prove the path

1. Enable (default on after `.env` is filled):

```sh
herdr plugin action invoke test --plugin oncall.telegram
```

2. Start an agent in a pane and park it on a permission dialog until the sidebar says `blocked`.
3. Telegram should get a two-line ping. **Do not answer from Telegram in v1** — attach with any SSH client and type in the pane.

Toggle:

```sh
herdr plugin action invoke toggle --plugin oncall.telegram
```

Optional keybind:

```toml
[[keys.command]]
key = "prefix+shift+t"
type = "plugin_action"
command = "oncall.telegram.toggle"
description = "toggle Oncall Telegram"
```

## Config

| key | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | BotFather token |
| `TELEGRAM_CHAT_ID` | required | numeric chat; only destination |
| `NOTIFY_ON` | `blocked` | comma list; add `done` only after blocked is reliable |
| `DEBOUNCE_MS` | `2000` | suppress repeat pane+status |
| `HERDR_TELEGRAM_ENABLED` | `1` | default before first toggle |
| `HERDR_TELEGRAM_SET_TITLE` | `1` | set host title while on |

## What v1 will not do

- send pane transcript to Telegram (keeps the first ping small)
- accept replies
- call `agent prompt` / `agent send-keys`

Those belong in v2, after this path is boringly reliable.
