import { feishuCard, sendFeishu, updateFeishuCard } from "../lib/index.mjs";
import { describeError } from "./poller.mjs";
import { NO_TARGET, REPLY_HELP, finishDelivery, lookupOutbound, replyTarget } from "./reply.mjs";

export function feishuChannel(creds, openId, deps = {}) {
  const send = deps.send ?? sendFeishu;
  return {
    name: "feishu",
    reply: (text) => send(creds, openId, text),
    ping: (text, { options = [] } = {}) => send(creds, openId, text, { options }),
  };
}

// Feishu redelivers an event it thinks went unacked, and pressing "1" twice
// into a pane is not harmless. The poller is one long-lived process, so a
// short memory of event ids is enough.
const seenEvents = new Map();
const SEEN_LIMIT = 500;

function alreadySeen(eventId, seen) {
  if (!eventId) {
    return false;
  }
  if (seen.has(eventId)) {
    return true;
  }
  seen.set(eventId, Date.now());
  if (seen.size > SEEN_LIMIT) {
    seen.delete(seen.keys().next().value);
  }
  return false;
}

// Returns { response?, work?, skipped? }. `response` rides back in the frame's
// ack and has to be ready at once: a card tap gets three seconds before Feishu
// shows the user an error. `work` is the delivery itself, which the poller runs
// behind any other so two replies never type into panes at the same time.
// `deps` carries the identity (`creds`, `openId`) and, for tests, the edges:
// `send`, `updateCard`, `run`, `wait`, `seen`.
export function handleFeishuEvent(envelope, deps) {
  const header = envelope?.header ?? {};
  if (header.app_id && deps.creds?.appId && header.app_id !== deps.creds.appId) {
    return { skipped: "app" };
  }
  if (alreadySeen(header.event_id, deps.seen ?? seenEvents)) {
    return { skipped: "duplicate" };
  }
  if (header.event_type === "im.message.receive_v1") {
    return onMessage(envelope.event, deps);
  }
  if (header.event_type === "card.action.trigger") {
    return onCardAction(envelope.event, deps);
  }
  return { skipped: "event" };
}

export function feishuMessageText(message) {
  if (message?.message_type !== "text") {
    return "";
  }
  try {
    // A mention in a chat arrives as a placeholder such as @_user_1.
    return String(JSON.parse(message.content)?.text ?? "")
      .replace(/@_(?:user_\d+|all)\b/g, "")
      .trim();
  } catch {
    return "";
  }
}

function onMessage(event, deps) {
  const sender = event?.sender?.sender_id?.open_id;
  const message = event?.message ?? {};
  // Only the user who scanned the pairing code may drive panes.
  if (!deps.openId || sender !== deps.openId) {
    console.log(`feishu sender mismatch got=${sender || "none"}`);
    return { skipped: "sender" };
  }
  if (message.chat_type && message.chat_type !== "p2p") {
    return { skipped: "chat" };
  }
  const text = feishuMessageText(message);
  if (!text) {
    return { skipped: "no-text" };
  }
  const channel = feishuChannel(deps.creds, deps.openId, deps);
  if (text.startsWith("/") || /^help$/i.test(text)) {
    if (/^\/?(help|start)$/i.test(text)) {
      return {
        work: async () => {
          await channel.reply(REPLY_HELP);
          return { skipped: "command" };
        },
      };
    }
    return { skipped: "command" };
  }
  // Quoting a ping ("reply" in Feishu) names it; a bare message goes to the
  // pane the last ping was about.
  const target = replyTarget(message.parent_id || message.root_id);
  if (!target?.paneId) {
    return {
      work: async () => {
        await channel.reply(NO_TARGET);
        return { skipped: "no-target" };
      },
    };
  }
  return { work: () => finishDelivery(target, text, { ...deps, channel }) };
}

function toast(type, content) {
  return { toast: { type, content } };
}

function chosenLabel(options, send) {
  const option = (options ?? []).find((item) => String(item.send || item.key) === send);
  return option ? `${option.key}. ${option.label}` : send;
}

function onCardAction(event, deps) {
  const operator = event?.operator?.open_id;
  if (!deps.openId || operator !== deps.openId) {
    console.log(`feishu callback operator mismatch got=${operator || "none"}`);
    return { skipped: "sender", response: toast("error", "not paired with this machine") };
  }
  const send = String(event?.action?.value?.send ?? "").trim();
  if (!send) {
    return { skipped: "no-data" };
  }
  const messageId = event?.context?.open_message_id ?? event?.open_message_id;
  // A tap always names its own card, so a card we do not know is not a reason
  // to fall back to the most recent ping and press a key into some other pane.
  const record = lookupOutbound(messageId);
  console.log(`feishu callback data=${send} pane=${record?.paneId || "none"}`);
  if (!record?.paneId) {
    return { skipped: "no-target", response: toast("error", "no pane mapped for that button") };
  }
  const channel = feishuChannel(deps.creds, deps.openId, deps);
  const label = chosenLabel(record.options, send);
  const card = (note) => feishuCard({ text: record.text ?? "", note });
  const updateCard = deps.updateCard ?? updateFeishuCard;
  // The buttons go at once, so the card cannot be pressed twice; once the
  // reply has landed (or been refused as stale) the card says which.
  const ack = async (text) => {
    try {
      await updateCard(deps.creds, messageId, card(`${label}\n${text}`));
    } catch (error) {
      console.error(`feishu card update failed: ${describeError(error)}`);
      await channel.reply(text);
    }
  };
  return {
    response: { ...toast("info", "sending"), card: { type: "raw", data: card(`${label}\nsending`) } },
    work: () => finishDelivery({ ...record, explicit: true }, send, { ...deps, channel, ack }),
  };
}
