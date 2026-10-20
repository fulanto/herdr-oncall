import { randomBytes } from "node:crypto";
import {
  channelList,
  clearFeishuPair,
  feishuRegistrationBegin,
  feishuRegistrationWait,
  loadDotEnv,
  panelAvailable,
  printQr,
  readFeishuPair,
  seedConfigEnv,
  sendFeishu,
  showPanel,
  upsertEnvValue,
  writeFeishuPair,
} from "../lib/index.mjs";
import { describeError, restartPoller, spawnDetached, withTimestamps } from "../inbound/poller.mjs";

// Pair Feishu by scanning: Feishu's app registration creates a bot app for the
// person who scans and hands back its credentials together with their open_id,
// so one scan is both the bot setup and the pairing. Nothing to paste.
//
//   pair-feishu.mjs            start a registration, print its QR code
//   pair-feishu.mjs wait <id>  the background worker that waits for the scan

const CAPTION = [
  "Scan with the Feishu app to create your Oncall bot and pair it with this Mac.",
  "用飞书扫码，创建 Oncall 机器人并与这台电脑配对。",
  "Esc cancels.",
].join("\n");

loadDotEnv();
seedConfigEnv();

if (process.argv[2] === "wait") {
  withTimestamps();
  process.exit(await waitForScan(process.argv[3]));
}

let begun;
try {
  begun = await feishuRegistrationBegin();
} catch (error) {
  console.error(describeError(error));
  process.exit(1);
}
const id = randomBytes(8).toString("hex");
writeFeishuPair({
  id,
  deviceCode: begun.deviceCode,
  url: begun.url,
  interval: begun.interval,
  exp: Date.now() + begun.expiresIn * 1000,
});
console.log(`scan with the Feishu app, expires in ${Math.round(begun.expiresIn / 60)} min:`);
console.log(`open: ${begun.url}`);
printQr(begun.url);
if (typeof globalThis.WebSocket !== "function") {
  console.log(`note: replies from Feishu need Node 22 or later; this is ${process.version}`);
}
// A scan can take minutes. Waiting in a detached worker lets this action return
// as soon as the code is printed, the way Telegram's pair does, rather than
// depending on how long Herdr lets an action run.
const pid = spawnDetached("src/actions/pair-feishu.mjs", ["wait", id]);
console.log(
  panelAvailable()
    ? "a QR panel is open on this Mac; it closes once you scan"
    : "waiting for the scan in the background",
);
console.log(`worker ${pid} logs to poller.log and writes FEISHU_* to .env once you approve`);

async function waitForScan(id) {
  const pending = readFeishuPair();
  if (!pending || pending.id !== id) {
    return 0;
  }
  const { deviceCode } = pending;
  // A newer pair overwrites the record; this worker then stands down.
  const mine = () => readFeishuPair()?.id === id;
  let outcome;
  const scanned = feishuRegistrationWait({
    deviceCode,
    interval: pending.interval,
    expiresAt: pending.exp,
    wanted: mine,
  })
    .catch((error) => ({ kind: "error", message: describeError(error) }))
    .then((result) => (outcome = result));

  if (panelAvailable()) {
    const shown = await showPanel({
      title: "scan with the Feishu app",
      where: "Pair Feishu",
      body: CAPTION,
      qr: pending.url,
      timeoutMs: Math.max(1000, pending.exp - Date.now()),
      until: () => outcome?.kind,
    });
    if (shown.kind === "dismiss") {
      // Closing the panel is a no; the registration notices on its next poll.
      clearFeishuPair(id);
    }
  }

  const result = await scanned;
  if (result.kind !== "paired") {
    clearFeishuPair(id);
    console.log(`feishu pairing ${result.kind}${result.message ? `: ${result.message}` : ""}`);
    return result.kind === "error" ? 1 : 0;
  }
  if (!result.openId) {
    clearFeishuPair(id);
    console.error("feishu pairing: no open_id came back, so there is no one to allow; not saved");
    return 1;
  }

  upsertEnvValue("FEISHU_APP_ID", result.appId);
  upsertEnvValue("FEISHU_APP_SECRET", result.appSecret);
  upsertEnvValue("FEISHU_OPEN_ID", result.openId);
  upsertEnvValue("FEISHU_DOMAIN", result.brand);
  // Scanning is choosing the channel: pings go to Feishu from now on. Someone
  // who wants both lists both.
  if (!channelList().includes("feishu")) {
    upsertEnvValue("CHANNEL", "feishu");
  }
  clearFeishuPair(id);
  const poller = restartPoller();
  console.log(`feishu paired · app ${result.appId} · open_id ${result.openId} · poller ${poller}`);

  const creds = { appId: result.appId, appSecret: result.appSecret, brand: result.brand };
  let body = "Pings reach you in Feishu now. Tap a button on a card, or reply to a message, to answer the pane.";
  try {
    await sendFeishu(creds, result.openId, "paired · this machine will send oncall here");
  } catch (error) {
    const detail = describeError(error);
    console.error(`feishu paired, but the first message failed: ${detail}`);
    body = `Paired, but the first message failed:\n${detail}`;
  }
  if (panelAvailable()) {
    await showPanel({
      title: "Feishu",
      where: "Paired",
      body,
      options: [{ key: "1", label: "OK" }],
      timeoutMs: 20_000,
    });
  }
  return 0;
}
