import { dirname } from "node:path";
import { seedConfigEnv } from "../lib/index.mjs";
import { restartPoller } from "../inbound/poller.mjs";

const envPath = seedConfigEnv();
const pid = restartPoller();
console.log(`config: ${envPath}`);
console.log(`example: ${dirname(envPath)}/.env.example`);
console.log(`poller: ${pid}`);
console.log("fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then:");
console.log("  herdr plugin action invoke test --plugin com.codreamer.herdr.oncall");
