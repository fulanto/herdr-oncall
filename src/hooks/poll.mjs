import {
  PLUGIN_ID,
  UPDATE_EVERY_MS,
  checkForUpdate,
  connectFeishu,
  feishuCreds,
  feishuOpenId,
  loadDotEnv,
  remoteChannels,
  runHerdrAsync,
  seedConfigEnv,
  sendRemote,
  sleep,
  telegramGetUpdates,
} from "../lib/index.mjs";
import { describeError, withTimestamps, writePollerPid } from "../inbound/poller.mjs";
import { handleFeishuEvent } from "../inbound/feishu.mjs";
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
function idleReporter(prefix, resumed) {
  let current;
  return (reason) => {
    if (reason !== current) {
      console.log(reason ? `${prefix}idle · ${reason}` : resumed);
      current = reason;
    }
  };
}

// One delivery at a time, whichever channel it came from: a reply that lands
// in a form waits up to 8 s for the next question, and two replies typing into
// panes at once would interleave their herdr calls.
let queue = Promise.resolve();
function serial(work) {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

function logResult(result) {
  if (result && !result.skipped) {
    console.log(JSON.stringify(result));
  } else if (result?.skipped && result.skipped !== "no-text") {
    console.log(`skip ${result.skipped}`);
  }
}

async function telegramLoop() {
  const reportIdle = idleReporter("", "polling · resumed");
  while (true) {
    // Every pass, so a token filled in after install, or a rotated one, reaches
    // the poller without a restart.
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
        logResult(await serial(() => handleTelegramUpdate(update, { token, chatId })));
      }
    } catch (error) {
      const described = describeError(error);
      console.error(described);
      await sleep(described.includes("Conflict") ? 8000 : 4000);
    }
  }
}

function feishuKey(creds, openId) {
  return creds ? `${creds.brand}:${creds.appId}:${creds.appSecret}:${openId}` : "";
}

// Feishu pushes replies and card taps down a long connection rather than
// answering a poll. A dropped connection is redialled, quickly after one that
// had been up for a while, with a growing pause after one that never held.
async function feishuLoop() {
  const reportIdle = idleReporter("feishu ", "feishu · listening");
  let pause = 0;
  while (true) {
    loadDotEnv();
    const creds = feishuCreds();
    const openId = feishuOpenId();
    if (!creds || !openId) {
      reportIdle("not paired (pair-feishu)");
      await sleep(8000);
      continue;
    }
    if (typeof globalThis.WebSocket !== "function") {
      reportIdle(`replies need Node 22 or later, this is ${process.version}`);
      await sleep(60_000);
      continue;
    }
    reportIdle(undefined);
    const key = feishuKey(creds, openId);
    const started = Date.now();
    try {
      const reason = await connectFeishu({
        creds,
        onEvent: (envelope) => dispatchFeishu(envelope, creds, openId),
        stillCurrent: () => {
          loadDotEnv();
          return feishuKey(feishuCreds(), feishuOpenId()) === key;
        },
      });
      console.log(`feishu · disconnected: ${reason}`);
    } catch (error) {
      console.error(`feishu · ${describeError(error)}`);
    }
    pause = Date.now() - started > 60_000 ? 2000 : Math.min(Math.max(pause * 2, 2000), 60_000);
    await sleep(pause);
  }
}

function dispatchFeishu(envelope, creds, openId) {
  const outcome = handleFeishuEvent(envelope, { creds, openId });
  if (outcome.work) {
    serial(outcome.work).then(logResult, (error) =>
      console.error(`feishu delivery failed: ${describeError(error)}`),
    );
  } else if (outcome.skipped && outcome.skipped !== "duplicate") {
    console.log(`feishu skip ${outcome.skipped}`);
  }
  return outcome.response;
}

// Releases reach installed copies without anyone running a command: at start
// (which is every Herdr start) and every few hours, ask Herdr to update this
// plugin from its release branch. On an update, say so on the paired chats,
// then hand over: the new installation's `poll` action restarts the poller
// from the new code, and stopping this process is part of that.
async function updateLoop() {
  let said;
  while (true) {
    try {
      const outcome = await checkForUpdate();
      if (outcome.updated) {
        const text = `oncall updated · v${outcome.from} → v${outcome.to}\n${outcome.url}`;
        console.log(`update · v${outcome.from} → v${outcome.to}`);
        for (const channel of remoteChannels()) {
          await sendRemote(channel, text, { status: "update" }).catch((error) =>
            console.error(`update notice failed · ${channel}: ${describeError(error)}`),
          );
        }
        await runHerdrAsync(["plugin", "action", "invoke", "poll", "--plugin", PLUGIN_ID]);
      } else if (outcome.failed) {
        console.error(`update failed · ${outcome.detail}`);
      } else {
        // Once per change, like the idle lines: every six hours a "current"
        // line says nothing new.
        const line = outcome.skipped ? `update skipped · ${outcome.skipped}` : `update · v${outcome.version} is current`;
        if (line !== said && outcome.skipped !== "checked recently") {
          console.log(line);
          said = line;
        }
      }
    } catch (error) {
      console.error(`update check failed · ${describeError(error)}`);
    }
    await sleep(UPDATE_EVERY_MS);
  }
}

await Promise.all([telegramLoop(), feishuLoop(), updateLoop()]);
