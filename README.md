# Oncall

Herdr **control plane**. Plugin id is `com.codreamer.herdr.oncall` (reverse-DNS). Telegram is a channel, not part of the id.

Telegram is only the first channel. If notify + reply work, a thin app talks to **this same plugin**. Do not mint `oncall.telegram` / `oncall.app` as extra Herdr plugins.

**v1 is notify-only:** when an agent becomes `blocked` or `done`, ping Telegram. No reply buttons, no `agent prompt`.

Derived from [`ogulcancelik/herdr-plugin-examples/agent-telegram-notify`](https://github.com/ogulcancelik/herdr-plugin-examples/tree/main/agent-telegram-notify). Differences:

- default `NOTIFY_ON=blocked,done`
- message includes workspace + pane id (for a later reply router)
- 2s debounce per pane+status
- `test` action

v2: reply → `agent send-keys` if still blocked; `agent prompt` only when idle/working.

## Install

```sh
herdr plugin install fulanto/herdr-oncall --yes
herdr plugin config-dir com.codreamer.herdr.oncall
```

第二行打印的目录里会有 `.env.example` 和一份空白 `.env`（`plugin install` 的 build 步骤种进去）。填 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。Token 不要进 git。已有 `.env` 不会被覆盖。

```sh
herdr plugin action invoke test --plugin com.codreamer.herdr.oncall
herdr plugin log list --plugin com.codreamer.herdr.oncall --limit 5
```

`plugin action invoke` **不会**把脚本 stdout 打到终端：它立刻返回一条 JSON（`plugin_action_invoked`，`status: running`）。真正的输出在 `plugin log list` 里。Telegram 里出现 test ping 就说明通路通了。

Needs Node.js 18+ and Herdr >= 0.7.0. Reinstall after pulling a new version:

```sh
herdr plugin uninstall com.codreamer.herdr.oncall
herdr plugin install fulanto/herdr-oncall --yes
```

Config `.env` in `config-dir` is kept across reinstalls.

If `plugin log` says `node not found`, Herdr's server PATH is not your login shell. v0.1.8 looks in nvm/fnm/mise/Homebrew and then `zsh -lic`. Reinstall, then invoke `test` again. Or start Herdr from a terminal where `command -v node` works.

改插件源码时再 clone：

```sh
git clone https://github.com/fulanto/herdr-oncall.git
node herdr-oncall/install.mjs
```

`install.mjs` 是直接跑 Node，所以路径会打在终端上。通过 `herdr plugin action invoke setup` 跑时同样进日志。

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
| `NOTIFY_ON` | `blocked,done` | comma list |
| `BLOCKED_DELAY_SEC` | `60` | wait this long after blocked; skip if already handled. `0` = immediate |
| `DEBOUNCE_MS` | `2000` | suppress repeat pane+status |
| `HERDR_TELEGRAM_ENABLED` | `1` | default before first toggle |
| `HERDR_TELEGRAM_SET_TITLE` | `1` | set host title while on |

## What v1 will not do

- send pane transcript
- accept replies
- call `agent prompt` / `agent send-keys`
- ship a phone app

Those sit behind this same `com.codreamer.herdr.oncall` id once the ping is reliable.
