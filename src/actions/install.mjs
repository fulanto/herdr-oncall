import { OLD_PLUGIN_IDS, PLUGIN_ID, pluginRoot, runHerdr, seedConfigEnv } from "../lib/index.mjs";
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
const pid = restartPoller();
console.log(`plugin: ${PLUGIN_ID}`);
console.log(`config: ${envPath}`);
console.log(`poller: ${pid}`);
console.log("fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then:");
console.log(`  herdr plugin action invoke test --plugin ${PLUGIN_ID}`);

