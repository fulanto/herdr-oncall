import { formatMessage, loadDotEnv, sendTelegram } from "./lib.mjs";

loadDotEnv();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

if (!token || !chatId) {
  console.error("missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
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
