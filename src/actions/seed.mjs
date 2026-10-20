import { dirname } from "node:path";
import {
  channelList,
  ensureIntegrations,
  feishuPaired,
  integrationLines,
  loadDotEnv,
  missingIntegrations,
  panelState,
  seedConfigEnv,
  setupHints,
} from "../lib/index.mjs";
import { restartPoller } from "../inbound/poller.mjs";

const envPath = seedConfigEnv();
const pid = restartPoller();
// Read only for the hints below, after the poller is spawned, so the poller
// still loads its own .env exactly as it did before.
loadDotEnv();
console.log(`config: ${envPath}`);
console.log(`example: ${dirname(envPath)}/.env.example`);
console.log(`poller: ${pid}`);
// Every build and every Herdr start, so an agent installed after Oncall is
// covered too; once installed, this is one `integration status` call.
const integrations = integrationLines(ensureIntegrations());
if (integrations.length) {
  console.log(integrations.join("\n"));
}
console.log(
  setupHints({
    panel: panelState(),
    token: process.env.TELEGRAM_BOT_TOKEN?.trim(),
    chatId: process.env.TELEGRAM_CHAT_ID?.trim(),
    feishu: feishuPaired(),
    channels: channelList(),
    integrations: missingIntegrations(),
    envPath,
  }).join("\n"),
);
