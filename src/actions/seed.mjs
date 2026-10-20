import { dirname } from "node:path";
import { loadDotEnv, panelState, seedConfigEnv, setupHints } from "../lib/index.mjs";
import { restartPoller } from "../inbound/poller.mjs";

const envPath = seedConfigEnv();
const pid = restartPoller();
// Read only for the hints below, after the poller is spawned, so the poller
// still loads its own .env exactly as it did before.
loadDotEnv();
console.log(`config: ${envPath}`);
console.log(`example: ${dirname(envPath)}/.env.example`);
console.log(`poller: ${pid}`);
console.log(
  setupHints({
    panel: panelState(),
    token: process.env.TELEGRAM_BOT_TOKEN?.trim(),
    chatId: process.env.TELEGRAM_CHAT_ID?.trim(),
    envPath,
  }).join("\n"),
);
