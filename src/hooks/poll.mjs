import { loadDotEnv, seedConfigEnv, sleep, telegramGetUpdates } from "../lib/index.mjs";
import { describeError, withTimestamps, writePollerPid } from "../inbound/poller.mjs";
import { handleTelegramUpdate, pollEnabled, readOffset, writeOffset } from "../inbound/reply.mjs";

seedConfigEnv();
loadDotEnv();
// This process is detached with its output redirected to <state>/poller.log,
// so every line needs to say when it happened.
withTimestamps();
writePollerPid(process.pid);
console.log(`oncall poller started pid=${process.pid}`);

// An idle poller looks exactly like a working one: silent. Saying why it is
// idle, once per change rather than once per pass, is the difference between
// reading the log and guessing — a poller with no token sat in this branch for
// an afternoon while replies went unanswered.
let idleReason;
function reportIdle(reason) {
  if (reason !== idleReason) {
    console.log(reason ? `idle · ${reason}` : "polling · resumed");
    idleReason = reason;
  }
}

while (true) {
  loadDotEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !pollEnabled()) {
    reportIdle(token ? "TELEGRAM_POLL is off" : "no TELEGRAM_BOT_TOKEN in .env");
    await sleep(8000);
    continue;
  }
  reportIdle(undefined);
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
    const described = describeError(error);
    console.error(described);
    await sleep(described.includes("Conflict") ? 8000 : 4000);
  }
}
