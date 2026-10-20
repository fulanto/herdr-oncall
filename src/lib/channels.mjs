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
