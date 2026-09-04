import { spawnSync } from "node:child_process";
import {
  loadDotEnv,
  pairDeepLink,
  seedConfigEnv,
  startPairing,
  telegramGetMe,
} from "../lib/index.mjs";
import { ensurePoller } from "../inbound/poller.mjs";

loadDotEnv();
seedConfigEnv();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  const envPath = seedConfigEnv();
  console.error(`put TELEGRAM_BOT_TOKEN in:\n${envPath}`);
  process.exit(1);
}

ensurePoller();

let username = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
if (!username) {
  try {
    const me = await telegramGetMe(token);
    username = me?.username;
  } catch (error) {
    console.error(error?.message || error);
  }
}

const record = startPairing({ botUsername: username });
const link = pairDeepLink(username, record.code);
const minutes = Math.round((record.exp - Date.now()) / 60000);

console.log(`code: ${record.code}`);
console.log(`expires in ${minutes} min`);
if (link) {
  console.log(`open: ${link}`);
  printQr(link);
} else {
  console.log("open your bot and send:");
  console.log(`  /start ${record.code}`);
}
console.log("poller writes TELEGRAM_CHAT_ID when the code is used.");

function printQr(url) {
  const printed = spawnSync("qrencode", ["-t", "ANSIUTF8", url], { encoding: "utf8" });
  if (printed.status === 0 && printed.stdout?.trim()) {
    console.log(printed.stdout);
    return;
  }
  const detail = printed.error?.message || printed.stderr?.trim() || `exit ${printed.status}`;
  console.error(`qrencode failed: ${detail}`);
}
