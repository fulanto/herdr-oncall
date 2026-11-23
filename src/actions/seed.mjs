import { dirname } from "node:path";
import {
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
  rolesActive,
  seedConfigEnv,
  setupHints,
} from "../lib/index.mjs";
import { restartPoller } from "../inbound/poller.mjs";

// Herdr runs this in two ways, and they differ in whose command it is.
//
// As the startup hook, when a server starts: in every session a machine has,
// each time against the same state dir. Only the session Oncall belongs to
// goes on; in any other, a server starting up is no business of the poller's.
// A startup that restarted it regardless is what handed the user's Feishu to
// a test session (src/lib/owner.mjs).
//
// As a build step, on install and update: Herdr strips its own environment
// from a build (no socket, no session), so a build is nobody's command. It
// seeds the config and says what is set up, as it always did, but it claims
// Oncall for no one: a claim made here would go to the default session
// whichever session the install was typed in. The poller starts with the first
// thing Oncall does in a real session. A build restarts it only when the
// default session is already the owner, which keeps an update's new code
// taking over at once there, as before.
const startup = process.env.HERDR_PLUGIN_EVENT === "startup";
const own = ownership({ claim: startup ? "first" : "never" });
for (const line of ownershipLines(own)) {
  console.log(line);
}
if (startup && !own.mine) {
  console.log(`skipped · startup · ${notOwnerReason(own)}`);
  process.exit(0);
}

const envPath = seedConfigEnv();
const pid = own.mine ? restartPoller() : 0;
// Read only for the hints below, after the poller is spawned, so the poller
// still loads its own .env exactly as it did before.
loadDotEnv();
console.log(`config: ${envPath}`);
console.log(`example: ${dirname(envPath)}/.env.example`);
if (own.mine) {
  console.log(`poller: ${pid}`);
} else {
  console.log(
    own.owner
      ? `poller: left alone · it serves the herdr session at ${own.owner.socket}`
      : "poller: starts with the first herdr session that runs Oncall",
  );
}
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
    enabled: modeEnabled(),
    drover: rolesActive(),
  }).join("\n"),
);
