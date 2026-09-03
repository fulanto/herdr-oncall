import { loadDotEnv, seedConfigEnv, sleep } from "./lib.mjs";
import { writePollerPid } from "./poller-ctl.mjs";
import {
  handleTelegramUpdate,
  pollEnabled,
  readOffset,
  telegramGetUpdates,
  writeOffset,
} from "./reply.mjs";

seedConfigEnv();
loadDotEnv();
writePollerPid(process.pid);
console.log(`oncall poller started pid=${process.pid}`);

while (true) {
  loadDotEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId || !pollEnabled()) {
    await sleep(8000);
    continue;
  }
  try {
    const updates = await telegramGetUpdates(token, readOffset());
    for (const update of updates) {
      writeOffset(Number(update.update_id) + 1);
      const result = await handleTelegramUpdate(update, { token, chatId });
      if (result && !result.skipped) {
        console.log(JSON.stringify(result));
      } else if (result?.skipped && result.skipped !== "no-text") {
        console.log(`skip ${result.skipped}`);
      }
    }
  } catch (error) {
    console.error(error?.message || error);
    await sleep(error?.message?.includes("Conflict") ? 8000 : 4000);
  }
}
