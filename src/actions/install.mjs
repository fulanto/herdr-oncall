import {
  OLD_PLUGIN_IDS,
  PLUGIN_ID,
  channelList,
  ensureIntegrations,
  feishuPaired,
  integrationLines,
  loadDotEnv,
  missingIntegrations,
  modeEnabled,
  notOwnerReason,
  ownership,
  ownershipLines,
  panelState,
  pluginRoot,
  rolesActive,
  runHerdr,
  seedConfigEnv,
  setupHints,
} from "../lib/index.mjs";
import { restartPoller } from "../inbound/poller.mjs";

const alreadyLinked = process.env.HERDR_PLUGIN_ID === PLUGIN_ID;

if (!alreadyLinked) {
  for (const id of [...OLD_PLUGIN_IDS, PLUGIN_ID]) {
    runHerdr(["plugin", "unlink", id]);
  }
  const linked = runHerdr(["plugin", "link", pluginRoot]);
  if (linked.error) {
    console.error(`herdr not found: ${linked.error.message}`);
    process.exit(1);
  }
  if (linked.status !== 0) {
    const detail = linked.stderr?.trim() || linked.stdout?.trim() || `exit ${linked.status}`;
    console.error(`herdr plugin link failed: ${detail}`);
    process.exit(1);
  }
  process.stdout.write(linked.stdout || "");
}

const envPath = seedConfigEnv();
// Linking and seeding the config are the same in every herdr session: the
// plugin registry and the config dir are the machine's. The poller is the
// owner session's, so a setup run anywhere else leaves it where it is.
const own = ownership();
const pid = own.mine ? restartPoller() : 0;
// Read only for the hints below, after the poller is spawned, so the poller
// still loads its own .env exactly as it did before.
loadDotEnv();
console.log(`plugin: ${PLUGIN_ID}`);
console.log(`config: ${envPath}`);
for (const line of ownershipLines(own)) {
  console.log(line);
}
console.log(own.mine ? `poller: ${pid}` : `poller: left alone · ${notOwnerReason(own)}`);
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
    enabled: modeEnabled(),
    drover: rolesActive(),
  }).join("\n"),
);

