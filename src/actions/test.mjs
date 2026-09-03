import { formatMessage, loadDotEnv, seedConfigEnv, sendTelegram } from "../lib/index.mjs";

loadDotEnv();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

if (!token || !chatId) {
  const envPath = seedConfigEnv();
  console.error(`fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in:\n${envPath}`);
  process.exit(1);
}

const text = formatMessage(
  {
    workspace_label: "test",
    tab_label: "dev",
    focused_pane_agent: "claude",
  },
  { data: { pane_id: "w0:p0", agent_status: "blocked", display_agent: "claude" } },
  "blocked",
);

await sendTelegram(token, chatId, `test ping\n\n${text}`);
console.log("sent test ping");
