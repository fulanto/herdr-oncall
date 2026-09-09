# Oncall

Herdr **control plane**. Plugin id is `com.codreamer.herdr.oncall` (reverse-DNS). Telegram is a channel, not part of the id.

Telegram is only the first channel. If notify + reply work, a thin app talks to **this same plugin**. Do not mint `oncall.telegram` / `oncall.app` as extra Herdr plugins.

**v2:** ping Telegram on `blocked` / `done`. Reply to that ping to send input into the pane.

- still `blocked` → ping includes the dialog tail and a button per option (Codex `y` / `p` / `esc`). Tap the button; type only if you need an answer that is not in the list
- `done` → ping includes the last assistant turn (not the full transcript). Reply with a new instruction
- only your `TELEGRAM_CHAT_ID` is accepted
- a message that is not a reply goes to the last pinged pane
- the location line names the repo, the worktree or branch the pane is working in, the tab, and the pane

**v0.4, macOS:** a desktop panel comes first. On `blocked` a floating window opens in the top-right corner of the screen you are on (it follows you across Spaces) with the tool call and dialog, one button per option, and a text field. Enter picks option 1, Cmd+N picks option N, typing sends that text. Answer there and no Telegram ping is sent. Let it time out (`BLOCKED_DELAY_SEC`) and Telegram takes over. On `done` the panel shows the last turn with a field for the next instruction; Telegram is pinged at the same time. The panel stays out of the way when you are already looking at the pane (Herdr's focused pane, terminal in front), and closes by itself once the pane is answered in Herdr or you switch to it.

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

Then put the bot token in that config dir and pair the chat:

```sh
herdr plugin config-dir com.codreamer.herdr.oncall
```

Edit `.env` there: `TELEGRAM_BOT_TOKEN=…`. Leave `TELEGRAM_CHAT_ID` empty if you want pairing.

```sh
herdr plugin action invoke poll --plugin com.codreamer.herdr.oncall
herdr plugin action invoke pair --plugin com.codreamer.herdr.oncall
```

Open the printed `t.me/…?start=…` link on your phone (or send `/start CODE` to the bot). The poller writes `TELEGRAM_CHAT_ID`. Plugin installation installs `qrencode` automatically with Homebrew on macOS and a supported system package manager on Linux, then prints a terminal QR. Linux installation needs root or passwordless `sudo` when `qrencode` is not already installed.

`plugin action invoke` returns JSON immediately; real output is `plugin log list`.

```sh
herdr plugin action invoke test --plugin com.codreamer.herdr.oncall
herdr plugin log list --plugin com.codreamer.herdr.oncall --limit 5
```

Reply in Telegram to the test ping. You should get `sent · …` or `failed · …`.

Needs Node.js 18+ and Herdr >= 0.7.0. Config `.env` is kept across reinstalls.

The desktop panel needs Xcode Command Line Tools (`xcode-select --install`). Install compiles `src/desktop/panel.swift` once into `bin/oncall-panel` inside the plugin directory; without `swiftc` the panel is skipped and Telegram still works.

If `plugin log` says `node not found`, start Herdr from a terminal where `command -v node` works.

## Config

| key | default | meaning |
|---|---|---|
| `CHANNEL` | `telegram` | delivery path; plugin id does not change if you add `app` |
| `TELEGRAM_BOT_TOKEN` | required | BotFather token |
| `TELEGRAM_CHAT_ID` | pair or manual | numeric chat; only destination |
| `NOTIFY_ON` | `blocked,done` | comma list |
| `BLOCKED_DELAY_SEC` | `60` | wait after blocked; skip if already handled. `0` = immediate |
| `DEBOUNCE_MS` | `2000` | suppress repeat pane+status |
| `TELEGRAM_POLL` | `1` | long-poll for replies |
| `TELEGRAM_FORCE_REPLY` | `1` | force reply box on pings |
| `HERDR_TELEGRAM_ENABLED` | `1` | outbound toggle default |
| `HERDR_TELEGRAM_SET_TITLE` | `1` | set host title while on |
| `DESKTOP_PANEL` | `1` | macOS floating panel before Telegram; `0` = off |
| `DESKTOP_PANEL_TIMEOUT_SEC` | `BLOCKED_DELAY_SEC` | how long the panel stays open (60 when the delay is 0) |
| `DESKTOP_PANEL_TERMINALS` | empty | extra terminal bundle ids that count as "you are at the pane" |

## What this plugin will not do

- send the full pane transcript (blocked: dialog tail; done: last assistant turn)
- ship a phone app
- show a system notification banner with buttons: macOS only allows that for a signed app bundle, so the panel is a plain floating window instead

## Layout

```text
herdr-plugin.toml
.env.example
bin/run-node.sh
bin/install-deps.sh   # qrencode + compiles the panel
src/desktop/    # panel.swift, macOS floating panel
src/lib/        # shared
src/hooks/      # notify + telegram poller
src/inbound/    # replies / pane delivery
src/actions/    # setup, pair, test, toggle, poll
test/
```

## License

MIT © 2026 fulanto. See [LICENSE](LICENSE).
