import {
  chatPartsText,
  downloadFeishuImage,
  feishuCard,
  fetchChatImages,
  modeEnabled,
  roleSettings,
  rolesActive,
  sendFeishu,
  textParts,
  updateFeishuCard,
} from "../lib/index.mjs";
import { describeError } from "./poller.mjs";
import { OFF_NOTICE, isChatCommand, routeChatMessage } from "./main-inbox.mjs";
import { NO_TARGET, REPLY_HELP, finishDelivery, lookupOutbound, readyChatParts, replyTarget } from "./reply.mjs";

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

// What a message type is called in a reply that turns it away: the names
// Feishu's 接收消息内容 page gives them
// (https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content).
// Any type not listed is named by its own id.
const UNSUPPORTED_TYPES = {
  file: "文件",
  folder: "文件夹",
  audio: "音频",
  media: "视频",
  sticker: "表情包",
  interactive: "卡片",
  hongbao: "红包",
  share_calendar_event: "日程分享卡片",
  calendar: "日程邀请卡片",
  general_calendar: "日程卡片",
  share_chat: "群名片",
  share_user: "个人名片",
  system: "系统消息",
  location: "位置",
  video_chat: "视频通话",
  todo: "任务",
  vote: "投票",
  merge_forward: "合并转发的消息",
};

function unsupportedName(type) {
  return UNSUPPORTED_TYPES[type] ?? `这类消息（${type || "未知类型"}）`;
}

function parseContent(message) {
  try {
    const content = JSON.parse(message.content);
    return content && typeof content === "object" ? content : undefined;
  } catch {
    return undefined;
  }
}

// A mention is a placeholder (@_user_1) whose name is in message.mentions; a
// Markdown one (content_v2's md tag) names the user by open_id instead.
function mentionNames(message) {
  const names = new Map();
  for (const mention of Array.isArray(message?.mentions) ? message.mentions : []) {
    if (mention?.name) {
      for (const id of [mention.key, mention.id?.open_id, mention.id?.user_id, mention.id?.union_id]) {
        if (id) {
          names.set(id, mention.name);
        }
      }
    }
  }
  return names;
}

function atText(name) {
  return name ? `@${name}` : "";
}

// One element of a post's line, as words. Images, videos, code blocks and
// rules are not words and are handled by the caller.
function postWords(element, names) {
  switch (element.tag) {
    case "text":
      return String(element.text ?? "");
    case "a": {
      const text = String(element.text ?? "").trim();
      const href = String(element.href ?? "").trim();
      return !href || text === href ? text || href : text ? `${text} (${href})` : href;
    }
    case "at":
      return atText(element.user_name || names.get(element.user_id) || (element.user_id === "all" ? "所有人" : ""));
    case "emotion":
      return element.emoji_type ? `[${element.emoji_type}]` : "";
    case "md":
      return String(element.text ?? "").replace(/<at\s+user_id="([^"]*)"\s*>([^<]*)<\/at>/g, (_, id, inner) =>
        atText(inner.trim() || names.get(id) || (id === "all" ? "所有人" : "")),
      );
    default:
      return typeof element.text === "string" ? element.text : "";
  }
}

// A rich-text post: its title, then line by line in order. content_v2 is the
// same as content except where the user wrote Markdown, which only it keeps
// (as `md` elements), and Feishu recommends it
// (https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content).
function postParts(content, message) {
  const names = mentionNames(message);
  const markdown = Array.isArray(content.content_v2) && content.content_v2.some((row) => Array.isArray(row) && row.some((element) => element?.tag === "md"));
  const rows = markdown ? content.content_v2 : Array.isArray(content.content) ? content.content : [];
  const parts = [];
  let lines = [];
  let line = "";
  let images = 0;
  // The words so far become a text part, before an image or a video.
  const endText = () => {
    if (line.trim()) {
      lines.push(line);
    }
    line = "";
    const text = lines.join("\n").trim();
    if (text) {
      parts.push({ type: "text", text });
    }
    lines = [];
  };
  // A code block or a rule sits on lines of its own.
  const ownLines = (text) => {
    if (line.trim()) {
      lines.push(line);
    }
    line = "";
    lines.push(text);
  };
  if (String(content.title ?? "").trim()) {
    lines.push(String(content.title).trim());
  }
  for (const row of rows) {
    const elements = (Array.isArray(row) ? row : []).filter((element) => element && typeof element === "object");
    for (const element of elements) {
      if (element.tag === "img" || element.tag === "media") {
        endText();
        parts.push(element.tag === "img" ? { type: "image", n: ++images, key: element.image_key } : { type: "skipped", what: "视频" });
      } else if (element.tag === "code_block") {
        ownLines(`\`\`\`${String(element.language ?? "").toLowerCase()}\n${String(element.text ?? "").replace(/\n$/, "")}\n\`\`\``);
      } else if (element.tag === "hr") {
        ownLines("---");
      } else {
        line += postWords(element, names);
      }
    }
    // A line the user left empty stays a blank line.
    if (line.trim() || !elements.length) {
      lines.push(line);
    }
    line = "";
  }
  endText();
  return parts;
}

// A Feishu message as the parts it was written in (see lib/chat-images.mjs),
// or { unsupported: "<what it is, in Chinese>" } for a kind that cannot go in.
export function parseFeishuMessage(message) {
  const type = message?.message_type;
  if (type !== "text" && type !== "post" && type !== "image") {
    return { unsupported: unsupportedName(type) };
  }
  const content = parseContent(message);
  if (!content) {
    return { parts: [] };
  }
  if (type === "image") {
    return { parts: [{ type: "image", n: 1, key: content.image_key }] };
  }
  if (type === "post") {
    return { parts: postParts(content, message) };
  }
  // A mention in a chat arrives as a placeholder such as @_user_1.
  const text = String(content.text ?? "")
    .replace(/@_(?:user_\d+|all)\b/g, "")
    .trim();
  return { parts: text ? [{ type: "text", text }] : [] };
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
  const channel = feishuChannel(deps.creds, deps.openId, deps);
  const parsed = parseFeishuMessage(message);
  if (parsed.unsupported) {
    return {
      work: async () => {
        console.log(`feishu · ${message.message_type} message not supported`);
        await channel.reply(`暂不支持${parsed.unsupported}，没送进去`);
        return { skipped: "unsupported", type: message.message_type };
      },
    };
  }
  const { parts } = parsed;
  if (!parts.length) {
    return {
      work: async () => {
        await channel.reply("没送进去：消息里没有能送的内容");
        return { skipped: "no-text" };
      },
    };
  }
  const text = chatPartsText(parts);
  // A command is words; one sent with an image is not run and the image does
  // not go in, since without drover `agent prompt` would run a leading `/`.
  if (isChatCommand(text) && parts.some((part) => part.type === "image")) {
    return {
      work: async () => {
        await channel.reply("以 / 开头的是命令，命令不能带图片，这条没执行也没送");
        return { skipped: "command-with-image" };
      },
    };
  }
  // The images are fetched in the queued work, only once the message is known
  // to go somewhere, and never before the ack.
  const fetchImages = (items) =>
    fetchChatImages(items, {
      messageId: message.message_id,
      download: (key) => downloadFeishuImage(deps.creds, message.message_id, key, { fetchImpl: deps.fetchImpl }),
    });
  // With drover: commands, the off switch, and a line to the main session.
  // The identity checks above stay exactly as they are.
  const settings = deps.settings ?? roleSettings();
  if (rolesActive(settings)) {
    return {
      work: () =>
        routeChatMessage(parts, {
          channel,
          quotedId: message.parent_id || message.root_id,
          messageId: message.message_id,
          settings,
          run: deps.run,
          wait: deps.wait,
          now: deps.now,
          enabled: deps.enabled,
          setEnabled: deps.setEnabled,
          channelFor: deps.channelFor,
          fetchImages,
          deps,
        }),
    };
  }
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
  return {
    work: async () => {
      const ready = await readyChatParts(parts, { fetchImages, channel });
      return ready ? finishDelivery(target, ready, { ...deps, channel }) : { skipped: "nothing-to-send" };
    },
  };
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
  // With drover, off means nothing from the chat reaches a pane, taps included.
  if (rolesActive(deps.settings ?? roleSettings()) && !(deps.enabled ?? modeEnabled())) {
    return { skipped: "off", response: toast("error", OFF_NOTICE) };
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
    work: () => finishDelivery({ ...record, explicit: true }, textParts(send), { ...deps, channel, ack }),
  };
}
