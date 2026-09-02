# Oncall

Herdr **control plane**. Plugin id is `com.codreamer.herdr.oncall` (reverse-DNS). Telegram is a transport, not part of the id.

Telegram is only the first transport. If notify + reply work, a thin app talks to **this same plugin**. Do not mint `oncall.telegram` / `oncall.app` as extra Herdr plugins.

**v1 is notify-only:** when an agent becomes `blocked`, ping Telegram. No reply buttons, no `agent prompt`.

Derived from [`ogulcancelik/herdr-plugin-examples/agent-telegram-notify`](https://github.com/ogulcancelik/herdr-plugin-examples/tree/main/agent-telegram-notify). Differences:

- default `NOTIFY_ON=blocked` (the example also fired on `done`)
- message includes workspace + pane id (for a later reply router)
- 2s debounce per pane+status
- `test` action

v2: reply → `agent send-keys` if still blocked; `agent prompt` only when idle/working.

## Install

Repo is private. Clone, then link:

```sh
git clone git@github.com:fulanto/herdr-oncall.git
cd herdr-oncall
herdr plugin link .
CONFIG_DIR="$(herdr plugin config-dir com.codreamer.herdr.oncall)"
cp .env.example "$CONFIG_DIR/.env"
```

Fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Token stays in the config directory, never in git.

If Herdr can see a public copy later:

```sh
herdr plugin install fulanto/herdr-oncall
```

Requires Node.js 18+, Herdr >= 0.7.0, no npm packages.

If you already linked an older id (`oncall`, `oncall.telegram`, `fulanto.oncall`), unlink it and link this tree again.

## Prove the path

```sh
herdr plugin action invoke test --plugin com.codreamer.herdr.oncall
```

Park an agent on a permission dialog until the sidebar says `blocked`. Telegram should get a two-line ping. **Do not answer from Telegram in v1** — type in the pane.

Toggle:

```sh
herdr plugin action invoke toggle --plugin com.codreamer.herdr.oncall
```

```toml
[[keys.command]]
key = "prefix+shift+t"
type = "plugin_action"
command = "com.codreamer.herdr.oncall.toggle"
description = "toggle Oncall"
```

## Config

| key | default | meaning |
|---|---|---|
| `TRANSPORT` | `telegram` | v1 channel; plugin id does not change if you add `app` |
| `TELEGRAM_BOT_TOKEN` | required | BotFather token |
| `TELEGRAM_CHAT_ID` | required | numeric chat; only destination |
| `NOTIFY_ON` | `blocked` | comma list |
| `DEBOUNCE_MS` | `2000` | suppress repeat pane+status |
| `HERDR_TELEGRAM_ENABLED` | `1` | default before first toggle |
| `HERDR_TELEGRAM_SET_TITLE` | `1` | set host title while on |

## What v1 will not do

- send pane transcript
- accept replies
- call `agent prompt` / `agent send-keys`
- ship a phone app

Those sit behind this same `com.codreamer.herdr.oncall` id once the ping is reliable.
