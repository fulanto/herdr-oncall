# Oncall

Herdr **control plane**. Plugin id is `com.codreamer.herdr.oncall` (reverse-DNS). Telegram is a channel, not part of the id.

Telegram is only the first channel. If notify + reply work, a thin app talks to **this same plugin**. Do not mint `oncall.telegram` / `oncall.app` as extra Herdr plugins.

**v1 is notify-only:** when an agent becomes `blocked`, ping Telegram. No reply buttons, no `agent prompt`.

Derived from [`ogulcancelik/herdr-plugin-examples/agent-telegram-notify`](https://github.com/ogulcancelik/herdr-plugin-examples/tree/main/agent-telegram-notify). Differences:

- default `NOTIFY_ON=blocked` (the example also fired on `done`)
- message includes workspace + pane id (for a later reply router)
- 2s debounce per pane+status
- `test` action

v2: reply → `agent send-keys` if still blocked; `agent prompt` only when idle/working.

## Install

```sh
git clone git@github.com:fulanto/herdr-oncall.git
node herdr-oncall/install.mjs
```

The script links the plugin, writes `.env` if missing, and prints the path. Fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` there. Token never goes in git.

Then:

```sh
herdr plugin action invoke test --plugin com.codreamer.herdr.oncall
```

Needs Node.js 18+ and Herdr >= 0.7.0. If you already linked an older id, `install.mjs` unlinks it first.

If the repo is public later:

```sh
herdr plugin install fulanto/herdr-oncall --yes
herdr plugin action invoke setup --plugin com.codreamer.herdr.oncall
```

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
| `CHANNEL` | `telegram` | v1 delivery path; plugin id does not change if you add `app` |
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
