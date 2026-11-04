import { channelList } from "./channels.mjs";
import { panelAvailable, showPanel } from "./desktop.mjs";
import {
  feishuCreds,
  feishuHosts,
  feishuOpenId,
  feishuRegistrationBegin,
  feishuVerifyCreds,
  sendFeishu,
} from "./feishu.mjs";
import { cancelFeishuPair, feishuPairId, upsertEnvValue } from "./pair.mjs";
import { actionCommand } from "./setup.mjs";

// What `pair-feishu` writes, and so what `unpair-feishu` takes away.
export const FEISHU_KEYS = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_OPEN_ID", "FEISHU_DOMAIN"];

function defaultPanel() {
  return panelAvailable() ? showPanel : undefined;
}

function plainError(error) {
  return error?.message || String(error);
}

// Each step's edges — the Feishu calls, the panel, the .env writes, the poller
// — come in through `deps`, so the decisions can be tested without a network
// or a bot. The actions pass the real ones.
function withDefaults(deps) {
  return {
    env: process.env,
    verify: feishuVerifyCreds,
    begin: feishuRegistrationBegin,
    send: sendFeishu,
    panel: defaultPanel(),
    setEnv: upsertEnvValue,
    cancelPending: cancelFeishuPair,
    restartPoller: () => undefined,
    log: console.log,
    error: console.error,
    describe: plainError,
    ...deps,
  };
}

// `pair-feishu` up to the QR code. Every scan of Feishu's app registration
// creates a bot, and there is no way to hand it an existing one, so a machine
// that is already paired must not get as far as `begin`: that is how a
// colleague who reinstalled, and scanned again, ended up with a second bot in
// Feishu. Returns { begun } — the registration's device code and page — when
// a scan should follow, or { code } with the exit code once it has said why
// not.
//
// Paired means all three of FEISHU_APP_ID, FEISHU_APP_SECRET and
// FEISHU_OPEN_ID are set, and Feishu still takes the credentials. Feishu
// saying the app is disabled or its secret is wrong leaves nothing to keep,
// and the scan goes ahead. Anything else — Feishu out of reach, a policy
// refusal, a rate limit — proves nothing either way, and creates nothing.
export async function startFeishuPairing(deps = {}) {
  const d = withDefaults(deps);
  const creds = feishuCreds(d.env);
  const openId = feishuOpenId(d.env);
  if (creds && openId) {
    const checked = await d.verify(creds);
    if (checked.ok) {
      return { code: await alreadyPaired(d, creds, openId) };
    }
    if (!checked.rejected) {
      return { code: await unverified(d, creds, checked.detail) };
    }
    d.log(`feishu: the paired app ${creds.appId} was refused by Feishu (${checked.detail}), so it cannot send; registering a new bot`);
    d.log(`飞书拒绝了已配对的机器人 ${creds.appId}（${checked.detail}），它已经发不出消息，重新创建一个。`);
  }
  try {
    return { begun: await d.begin() };
  } catch (error) {
    d.error(d.describe(error));
    return { code: 1 };
  }
}

async function unverified(d, creds, detail) {
  const unpair = actionCommand("unpair-feishu");
  d.error(`feishu: already paired (app ${creds.appId}), but Feishu could not confirm the pairing: ${detail}`);
  d.error("no new bot created; try again later");
  d.error(`if the bot really is gone, unpair first, then pair again: ${unpair}`);
  d.error(`已经配对过飞书，但现在无法向飞书确认凭据（${detail}），没有新建机器人，请稍后重试。`);
  if (d.panel) {
    await d.panel({
      title: "Feishu",
      where: "Could not check the pairing",
      body: [
        `Already paired (app ${creds.appId}), but Feishu could not confirm it: ${detail}`,
        "Nothing was created. Try again later.",
        `已经配对过飞书，但现在无法向飞书确认凭据，没有新建机器人，请稍后重试。`,
      ].join("\n"),
      options: [{ key: "1", label: "OK" }],
      timeoutMs: 20_000,
    });
  }
  return 1;
}

async function alreadyPaired(d, creds, openId) {
  const unpair = actionCommand("unpair-feishu");
  d.log(`feishu: already paired · app ${creds.appId} · open_id ${openId}`);
  d.log(`to pair again, unpair first: ${unpair}`);
  d.log(`then: ${actionCommand("pair-feishu")}`);
  d.log(`已经配对过飞书（机器人 ${creds.appId}），不用再配对。如需重新配对，请先解绑：${unpair}，再运行 pair-feishu。`);
  // Asking to pair Feishu is asking for pings there, as the first scan was.
  if (!channelList(d.env.CHANNEL).includes("feishu")) {
    d.setEnv("CHANNEL", "feishu");
    d.log(`CHANNEL set to feishu · poller ${d.restartPoller()}`);
  }
  // The message is how the user finds the chat the pings land in, and the one
  // proof that the bot can still reach that open_id. A failure is reported; it
  // is no reason to create anything.
  let failed;
  try {
    await d.send(creds, openId, "already paired · this machine sends oncall here");
  } catch (error) {
    failed = d.describe(error);
    d.error(`feishu already paired, but the message to it failed: ${failed}`);
  }
  if (d.panel) {
    const body = [
      `Already paired with Feishu (app ${creds.appId}). Nothing to scan.`,
      "已经配对过飞书，不用再扫码。",
      `To pair a new bot, unpair first: ${unpair}`,
      "如需重新配对，请先解绑（unpair-feishu），再运行 pair-feishu。",
    ];
    if (failed) {
      body.push(`But the message to Feishu failed:\n${failed}`);
    }
    await d.panel({
      title: "Feishu",
      where: "Already paired",
      body: body.join("\n"),
      options: [{ key: "1", label: "OK" }],
      timeoutMs: 20_000,
    });
  }
  return failed ? 1 : 0;
}

// `unpair-feishu`: forget the bot, so the next `pair-feishu` scans for a new
// one. The keys are emptied rather than deleted, the way `.env.example` ships
// them. The bot itself stays in Feishu — no API removes an app this way — so
// the output says where to delete it by hand.
//
// A scan still in progress is withdrawn first. Its worker would otherwise
// write the credentials back once the scan was approved, set CHANNEL and
// restart the poller, pairing the machine again right after it was unpaired.
export async function unpairFeishu(deps = {}) {
  const d = withDefaults(deps);
  const pending = d.cancelPending();
  if (pending) {
    d.log("feishu: cancelled the scan in progress, so it cannot pair this machine afterwards");
  }
  const present = FEISHU_KEYS.filter((key) => d.env[key]?.trim());
  if (!present.length) {
    d.log("feishu: not paired, nothing to unpair");
    d.log("飞书没有配对，不用解绑。");
    return 0;
  }
  const creds = feishuCreds(d.env);
  const openId = feishuOpenId(d.env);
  if (creds && openId) {
    // Best effort: the chat it leaves behind should say it went quiet on purpose.
    try {
      await d.send(creds, openId, "unpaired · this machine no longer sends oncall here");
    } catch (error) {
      d.error(`feishu: the unpaired message failed (${d.describe(error)}); unpairing anyway`);
    }
  }
  const openPlatform = `${feishuHosts(creds?.brand ?? d.env.FEISHU_DOMAIN).open}/app`;
  for (const key of FEISHU_KEYS) {
    d.setEnv(key, "");
  }
  // CHANNEL only ever named the channels to use, so Feishu leaves it. With
  // nothing left it falls back to what an empty CHANNEL means, telegram.
  const listed = channelList(d.env.CHANNEL);
  if (listed.includes("feishu")) {
    const rest = listed.filter((name) => name !== "feishu");
    d.setEnv("CHANNEL", rest.length ? rest.join(",") : "telegram");
  }
  const poller = d.restartPoller();
  d.log(
    creds && openId
      ? `feishu unpaired · app ${creds.appId} removed from .env · CHANNEL=${d.env.CHANNEL} · poller ${poller}`
      : `feishu was not fully paired · cleared ${present.join(", ")} from .env · poller ${poller}`,
  );
  if (creds) {
    d.log(`the old bot is still in Feishu; delete app ${creds.appId} at ${openPlatform} if you no longer want it`);
  }
  d.log(`pair-feishu now creates a new bot: ${actionCommand("pair-feishu")}`);
  d.log("已解绑飞书。旧机器人还留在飞书里，不需要的话请到飞书开放平台手动删除；再运行 pair-feishu 会新建一个机器人。");
  return 0;
}

// The scan worker's last step: write an approved scan into .env. Only while
// the scan is still this worker's. `unpair-feishu`, or a newer `pair-feishu`,
// may have withdrawn it while Feishu was approving it, and saving it then would
// pair the machine again against the user's latest word. Returns whether it
// saved. The app the scan created exists in Feishu either way, so one that is
// not saved is named for deleting.
export function saveFeishuPairing(result, { id, ...deps } = {}) {
  const d = withDefaults({ owns: () => feishuPairId() === id, ...deps });
  if (!d.owns()) {
    const openPlatform = `${feishuHosts(result.brand).open}/app`;
    d.log(
      `feishu pairing: the scan was withdrawn before its result was saved (unpair-feishu, or a newer pair-feishu); not saving app ${result.appId}`,
    );
    d.log(`that scan still created app ${result.appId} in Feishu; delete it at ${openPlatform} if you do not want it`);
    d.log("这次扫码在保存前已被撤销（unpair-feishu 或更新的 pair-feishu），没有写入配置；它创建的机器人可在飞书开放平台删除。");
    return false;
  }
  d.setEnv("FEISHU_APP_ID", result.appId);
  d.setEnv("FEISHU_APP_SECRET", result.appSecret);
  d.setEnv("FEISHU_OPEN_ID", result.openId);
  d.setEnv("FEISHU_DOMAIN", result.brand);
  // Scanning is choosing the channel: pings go to Feishu from now on. Someone
  // who wants both lists both.
  if (!channelList(d.env.CHANNEL).includes("feishu")) {
    d.setEnv("CHANNEL", "feishu");
  }
  return true;
}
