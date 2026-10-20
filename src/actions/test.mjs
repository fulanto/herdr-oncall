import {
  formatMessage,
  loadDotEnv,
  panelState,
  seedConfigEnv,
  sendTelegram,
  setupHints,
  showPanel,
} from "../lib/index.mjs";

loadDotEnv();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

if (!token || !chatId) {
  process.exit(await testPanel());
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

// Telegram is optional and the panel needs no setup, so with no chat paired the
// test is the panel. Without this a user who only wanted the panel was told to
// fill in a bot token, and had no way to see that the plugin already worked.
async function testPanel() {
  const panel = panelState();
  if (panel !== "ready") {
    const envPath = seedConfigEnv();
    console.error(["nothing to test yet:", ...setupHints({ panel, token, chatId, envPath })].join("\n"));
    return 1;
  }
  console.log("telegram not paired; opening a test panel");
  const result = await showPanel({
    title: "test · no pane",
    where: "Oncall test panel",
    body: "If you can see this, the desktop panel works.\nNothing pressed here reaches a pane.",
    options: [{ key: "1", label: "Looks good" }],
    timeoutMs: 30_000,
  });
  if (result.kind === "unavailable") {
    console.error("panel did not open");
    return 1;
  }
  const outcome =
    result.kind === "button"
      ? `button ${result.index + 1} pressed`
      : result.kind === "text"
        ? `typed "${result.text}"`
        : result.kind;
  console.log(`panel test: ${outcome}`);
  return 0;
}
