import { feishuCreds, feishuOpenId, sendFeishu } from "./feishu.mjs";
import { optionKeyboard } from "./format.mjs";
import { sendTelegram } from "./telegram.mjs";

// Remote channels: where a ping goes when the desk does not answer. `CHANNEL`
// picks among the paired ones (`telegram`, `feishu`, or both, comma-separated);
// replies are taken from every paired channel whatever it says, so answering
// on the one you happen to have open always works.
export const CHANNELS = ["telegram", "feishu"];

export function channelList(raw = process.env.CHANNEL) {
  const list = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => CHANNELS.includes(item));
  return list.length ? [...new Set(list)] : ["telegram"];
}

export function telegramPaired(env = process.env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim());
}

export function feishuPaired(env = process.env) {
  return Boolean(feishuCreds(env) && feishuOpenId(env));
}

export function channelPaired(name, env = process.env) {
  return name === "feishu" ? feishuPaired(env) : telegramPaired(env);
}

export function remoteChannels(env = process.env) {
  return channelList(env.CHANNEL).filter((name) => channelPaired(name, env));
}

// One ping on one channel. A blocked ping with choices carries them as buttons;
// anything else asks for a typed reply. Returns the message id replies and taps
// will name.
export async function sendRemote(name, text, { status, options = [] } = {}) {
  const choices = status === "blocked" ? options : [];
  if (name === "feishu") {
    return sendFeishu(feishuCreds(), feishuOpenId(), text, { options: choices });
  }
  return sendTelegram(process.env.TELEGRAM_BOT_TOKEN.trim(), process.env.TELEGRAM_CHAT_ID.trim(), text, {
    forceReply: choices.length === 0,
    replyMarkup: optionKeyboard(choices),
  });
}

// One ping on every channel given, each on its own: one that is down must not
// cost the other its ping. What went out is logged as well as what failed. A
// log that spoke only on failure could not tell a ping that was sent from one
// that was never attempted, and "the test arrives but a blocked ping does not"
// could not be answered from it at all. `sent(channel, messageId)` records the
// message so replies and taps can find their pane.
export async function pingChannels(
  channels,
  text,
  {
    status,
    options = [],
    where,
    send = sendRemote,
    sent = () => {},
    log = console.log,
    error = console.error,
    describe = (err) => err?.message || String(err),
  } = {},
) {
  for (const channel of channels) {
    try {
      const messageId = await send(channel, text, { status, options });
      log(`sent · ${channel} · ${where}`);
      sent(channel, messageId);
    } catch (err) {
      error(`${channel} ping failed · ${where}: ${describe(err)}`);
    }
  }
}
