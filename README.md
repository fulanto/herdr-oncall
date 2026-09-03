# Oncall

Herdr **control plane**. Plugin id is `com.codreamer.herdr.oncall` (reverse-DNS). Telegram is a channel, not part of the id.

Telegram is only the first channel. If notify + reply work, a thin app talks to **this same plugin**. Do not mint `oncall.telegram` / `oncall.app` as extra Herdr plugins.

**v2:** ping Telegram on `blocked` / `done`. Reply to that ping to send input into the pane.

- still `blocked` → ping includes the dialog tail and a button per option (Codex `y` / `p` / `esc`). Tap the button; type only if you need an answer that is not in the list
- `done` / `idle` / `working` → `agent prompt` (new instruction)
- only your `TELEGRAM_CHAT_ID` is accepted
- a message that is not a reply goes to the last pinged pane

Derived from [`ogulcancelik/herdr-plugin-examples/agent-telegram-notify`](https://github.com/ogulcancelik/herdr-plugin-examples/tree/main/agent-telegram-notify).

## Install

```sh
herdr plugin uninstall com.codreamer.herdr.oncall
herdr plugin install fulanto/herdr-oncall --yes
```

Install runs `seed.mjs`, which starts the Telegram poller — no Herdr restart. To force it:

```sh
herdr plugin action invoke poll --plugin com.codreamer.herdr.oncall
```

Then:

```sh
herdr plugin config-dir com.codreamer.herdr.oncall
```

Put token and chat id in `.env` there. `plugin action invoke` returns JSON immediately; real output is `plugin log list`.

```sh
herdr plugin action invoke test --plugin com.codreamer.herdr.oncall
herdr plugin log list --plugin com.codreamer.herdr.oncall --limit 5
```

Reply in Telegram to the test ping. You should get `sent · …` or `failed · …`.

Needs Node.js 18+ and Herdr >= 0.7.0. Config `.env` is kept across reinstalls.

If `plugin log` says `node not found`, start Herdr from a terminal where `command -v node` works.

## Config

| key | default | meaning |
|---|---|---|
| `CHANNEL` | `telegram` | delivery path; plugin id does not change if you add `app` |
| `TELEGRAM_BOT_TOKEN` | required | BotFather token |
| `TELEGRAM_CHAT_ID` | required | numeric chat; only destination |
| `NOTIFY_ON` | `blocked,done` | comma list |
| `BLOCKED_DELAY_SEC` | `60` | wait after blocked; skip if already handled. `0` = immediate |
| `DEBOUNCE_MS` | `2000` | suppress repeat pane+status |
| `TELEGRAM_POLL` | `1` | long-poll for replies |
| `TELEGRAM_FORCE_REPLY` | `1` | force reply box on pings |
| `HERDR_TELEGRAM_ENABLED` | `1` | outbound toggle default |
| `HERDR_TELEGRAM_SET_TITLE` | `1` | set host title while on |

## What this plugin will not do

- send the full pane transcript (only the blocked dialog tail)
- ship a phone app

## Layout

```text
herdr-plugin.toml
.env.example
bin/run-node.sh
src/lib/        # shared
src/hooks/      # notify + telegram poller
src/inbound/    # replies / pane delivery
src/actions/    # setup, test, toggle, poll
test/
```

## License

MIT © 2026 fulanto. See [LICENSE](LICENSE).
