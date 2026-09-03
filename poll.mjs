import { loadDotEnv, seedConfigEnv, sleep } from "./lib.mjs";
import {
  handleTelegramUpdate,
  pollEnabled,
  readOffset,
  telegramGetUpdates,
  writeOffset,
} from "./reply.mjs";

seedConfigEnv();
loadDotEnv();
console.log("oncall poller started");

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
      await handleTelegramUpdate(update, { token, chatId });
    }
  } catch (error) {
    console.error(error?.message || error);
    await sleep(4000);
  }
}
