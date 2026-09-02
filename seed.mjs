import { dirname } from "node:path";
import { seedConfigEnv } from "./lib.mjs";

const envPath = seedConfigEnv();
console.log(`config: ${envPath}`);
console.log(`example: ${dirname(envPath)}/.env.example`);
console.log("fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then:");
console.log("  herdr plugin action invoke test --plugin com.codreamer.herdr.oncall");
