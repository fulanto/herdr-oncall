import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stateDir } from "./paths.mjs";

// A chat message on its way into a pane, as the parts it was written in, in
// order:
//   { type: "text", text }
//   { type: "image", n, key }            n counts the message's images from 1;
//                                        once fetched it has `path`, or
//                                        `failed` with the reason in Chinese
//   { type: "skipped", what }            something that cannot go in (a video
//                                        inside a Feishu post)
// A Telegram message, or a Feishu text, is one text part.

export function textParts(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

// The words alone: what a command or a dialog answer is read from.
export function chatPartsText(parts) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function attachmentLine(part) {
  if (part.type === "skipped") {
    return `[${part.what} 没送：暂不支持]`;
  }
  return part.path ? `[图片] ${part.path}` : `[图片 没拿到：${part.failed || "没下载"}]`;
}

// The message as an agent's prompt: the words, with each image on a line of
// its own where it was in the message, as its absolute path (the agent opens
// it itself; measured on Claude Code 2.1.327, which reads it with its Read
// tool).
export function chatPartsPrompt(parts) {
  return parts.map((part) => (part.type === "text" ? part.text : attachmentLine(part))).join("\n");
}

// Images that made it to disk.
export function fetchedImages(parts) {
  return parts.filter((part) => part.type === "image" && part.path).length;
}

// Is there anything to type in? Words, or at least one image on disk.
export function chatPartsDeliverable(parts) {
  return parts.some((part) => (part.type === "text" ? part.text.trim() !== "" : part.type === "image" && Boolean(part.path)));
}

// What did not make it, for the reply to the user: "" when everything did.
export function undeliveredNote(parts) {
  return parts
    .map((part) => {
      if (part.type === "image" && !part.path) {
        return `第 ${part.n} 张图片没拿到：${part.failed || "没下载"}`;
      }
      return part.type === "skipped" ? `${part.what}暂不支持，没送` : "";
    })
    .filter(Boolean)
    .join("；");
}

// ---------------------------------------------------------------------------
// Where images are kept.

export const CHAT_IMAGE_KEEP_MS = 7 * 24 * 60 * 60_000;
// The only files this plugin writes there, and so the only ones it deletes.
const IMAGE_FILE = /^feishu-[A-Za-z0-9_-]+-\d+\.[a-z0-9]+$/;

// CHAT_IMAGE_DIR, with a leading ~ for the home directory, or chat-images in
// the state dir. drover sets it to ~/.drover/oncall-images, which its Claude
// Code rules let the main session read without asking (Read(~/.drover/**));
// the state dir has no such rule, so there the agent asks before each image.
export function chatImageDir(env = process.env, { log = console.log } = {}) {
  const fallback = join(stateDir(), "chat-images");
  const raw = env.CHAT_IMAGE_DIR?.trim();
  if (!raw) {
    return fallback;
  }
  const home = env.HOME || homedir();
  const path = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(path)) {
    log(`CHAT_IMAGE_DIR is not an absolute path (${raw}), using ${fallback}`);
    return fallback;
  }
  return path;
}

const TYPE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
};

function startsWith(bytes, prefix, at = 0) {
  return prefix.every((byte, index) => bytes[at + index] === byte);
}

// From the response's Content-Type, else from the first bytes.
export function imageExtension(contentType, bytes = new Uint8Array()) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (TYPE_EXTENSIONS[type]) {
    return TYPE_EXTENSIONS[type];
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return "png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "jpg";
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return "gif";
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return "bmp";
  }
  return "bin";
}

// Removes this plugin's images older than CHAT_IMAGE_KEEP_MS. Anything else in
// the directory is left alone.
export function pruneChatImages(dir, now = Date.now()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!IMAGE_FILE.test(name)) {
      continue;
    }
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isFile() && now - stat.mtimeMs > CHAT_IMAGE_KEEP_MS) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      /* gone already, or not ours to touch */
    }
  }
  return removed;
}

// feishu-<message id>-<n>.<ext>: one message's images never collide with
// another's, and a redelivered message writes the same names again. Only the
// user can read them.
export function saveChatImage({ messageId, n, bytes, contentType }, { dir = chatImageDir(), now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneChatImages(dir, now);
  const id = String(messageId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "message";
  const path = join(dir, `feishu-${id}-${n}.${imageExtension(contentType, bytes)}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

// Why an image did not come, in the words the user and the agent see.
export function imageFailureReason(error) {
  if (error?.tooLarge) {
    return `超过 ${Math.round(error.limit / (1024 * 1024))}MB`;
  }
  if (error?.feishuCode !== undefined) {
    return `飞书 ${error.feishuCode} ${String(error.detail ?? "").slice(0, 80)}`.trim();
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "下载超时";
  }
  if (error?.httpStatus) {
    return `HTTP ${error.httpStatus}`;
  }
  if (typeof error?.code === "string") {
    return `存不下 ${error.code}`;
  }
  return `网络错误 ${String(error?.message || error).slice(0, 80)}`.trim();
}

// Downloads and saves every image part, one at a time, in order. `download`
// is (key) => { bytes, contentType }. A failure is kept on its part, so the
// words around it still go in and the reply can say which image is missing.
export async function fetchChatImages(parts, { messageId, download, dir, now, log = console.log }) {
  const fetched = [];
  for (const part of parts) {
    if (part.type !== "image" || part.path) {
      fetched.push(part);
      continue;
    }
    try {
      if (!part.key) {
        throw new Error("no image key in the message");
      }
      const { bytes, contentType } = await download(part.key);
      const path = saveChatImage({ messageId, n: part.n, bytes, contentType }, { dir: dir ?? chatImageDir(), now: now ?? Date.now() });
      fetched.push({ ...part, path });
    } catch (error) {
      const failed = imageFailureReason(error);
      log(`chat image · message ${messageId} image ${part.n} · not fetched: ${failed}`);
      fetched.push({ ...part, failed });
    }
  }
  return fetched;
}
