import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHAT_IMAGE_KEEP_MS,
  attachmentLine,
  chatImageDir,
  chatPartsDeliverable,
  chatPartsPrompt,
  chatPartsText,
  downloadFeishuImage,
  fetchChatImages,
  imageExtension,
  imageFailureReason,
  pruneChatImages,
  saveChatImage,
  undeliveredNote,
} from "../src/lib/index.mjs";

// A real 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function withDirs(body) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "oncall-images-"));
    const saved = {
      state: process.env.HERDR_PLUGIN_STATE_DIR,
      config: process.env.HERDR_PLUGIN_CONFIG_DIR,
    };
    process.env.HERDR_PLUGIN_STATE_DIR = join(root, "state");
    process.env.HERDR_PLUGIN_CONFIG_DIR = join(root, "config");
    try {
      await body(root);
    } finally {
      for (const [key, value] of [
        ["HERDR_PLUGIN_STATE_DIR", saved.state],
        ["HERDR_PLUGIN_CONFIG_DIR", saved.config],
      ]) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "CHAT_IMAGE_DIR takes a leading ~, and unset means chat-images in the state dir",
  withDirs(async (root) => {
    assert.equal(chatImageDir({}), join(root, "state", "chat-images"));
    assert.equal(chatImageDir({ CHAT_IMAGE_DIR: "  " }), join(root, "state", "chat-images"));
    assert.equal(chatImageDir({ CHAT_IMAGE_DIR: "~/.drover/oncall-images", HOME: "/Users/someone" }), "/Users/someone/.drover/oncall-images");
    assert.equal(chatImageDir({ CHAT_IMAGE_DIR: "~", HOME: "/Users/someone" }), "/Users/someone");
    assert.equal(chatImageDir({ CHAT_IMAGE_DIR: "/srv/images" }), "/srv/images");
    // A relative path would depend on where the poller was started.
    const said = [];
    assert.equal(chatImageDir({ CHAT_IMAGE_DIR: "images" }, { log: (line) => said.push(line) }), join(root, "state", "chat-images"));
    assert.match(said[0], /not an absolute path/);
  }),
);

test("the extension comes from the Content-Type, else from the file's first bytes", () => {
  assert.equal(imageExtension("image/png", PNG), "png");
  assert.equal(imageExtension("image/jpeg; charset=binary"), "jpg");
  assert.equal(imageExtension("application/octet-stream", PNG), "png");
  assert.equal(imageExtension("", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(imageExtension("", Buffer.from("GIF89a")), "gif");
  assert.equal(imageExtension("", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(imageExtension("", Buffer.from("hello")), "bin");
});

test(
  "an image is saved under its message id and place, readable by the user alone",
  withDirs(async (root) => {
    const dir = join(root, "images");
    const first = saveChatImage({ messageId: "om_abc/../x", n: 1, bytes: PNG, contentType: "image/png" }, { dir });
    const second = saveChatImage({ messageId: "om_abc/../x", n: 2, bytes: PNG, contentType: "" }, { dir });
    assert.equal(first, join(dir, "feishu-om_abcx-1.png"));
    assert.equal(second, join(dir, "feishu-om_abcx-2.png"));
    assert.deepEqual(readFileSync(first), PNG);
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }),
);

test(
  "saving clears this plugin's images older than 7 days and nothing else",
  withDirs(async (root) => {
    const dir = join(root, "images");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = (now - CHAT_IMAGE_KEEP_MS - 60_000) / 1000;
    const file = (name, seconds) => {
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), seconds, seconds);
    };
    file("feishu-om_old-1.png", old);
    file("feishu-om_recent-1.jpg", (now - 60_000) / 1000);
    file("notes.txt", old);
    file("feishu-photo.png", old);
    mkdirSync(join(dir, "feishu-om_dir-1.png"));
    utimesSync(join(dir, "feishu-om_dir-1.png"), old, old);
    saveChatImage({ messageId: "om_new", n: 1, bytes: PNG, contentType: "image/png" }, { dir, now });
    assert.equal(existsSync(join(dir, "feishu-om_old-1.png")), false);
    for (const kept of ["feishu-om_recent-1.jpg", "notes.txt", "feishu-photo.png", "feishu-om_dir-1.png", "feishu-om_new-1.png"]) {
      assert.equal(existsSync(join(dir, kept)), true, kept);
    }
    assert.equal(pruneChatImages(join(root, "missing"), now), 0);
  }),
);

// Feishu as a stand-in: the token endpoint, and a resource endpoint that
// answers with `resource(url)`.
function feishuServer(resource) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: init?.headers?.authorization });
    if (String(url).includes("/auth/v3/tenant_access_token/internal")) {
      return Response.json({ code: 0, tenant_access_token: `t-${calls.length}`, expire: 7200 });
    }
    return resource(String(url), calls);
  };
  return { fetchImpl, calls };
}

test("an image is downloaded as the bytes Feishu serves, with the bot's token", async () => {
  const server = feishuServer(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
  const creds = { appId: "cli_download", appSecret: "s", brand: "feishu" };
  const file = await downloadFeishuImage(creds, "om_1", "img_v3_1", { fetchImpl: server.fetchImpl });
  assert.deepEqual(Buffer.from(file.bytes), PNG);
  assert.equal(file.contentType, "image/png");
  const resource = server.calls.at(-1);
  assert.equal(resource.url, "https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/img_v3_1?type=image");
  assert.equal(resource.method, "GET");
  assert.match(resource.auth, /^Bearer t-/);
});

test("a refused download says Feishu's code, a stale token is retried once", async () => {
  const notInMessage = feishuServer(() => Response.json({ code: 234003, msg: "File not in msg." }, { status: 400 }));
  const creds = { appId: "cli_refused", appSecret: "s", brand: "feishu" };
  const error = await downloadFeishuImage(creds, "om_1", "img_x", { fetchImpl: notInMessage.fetchImpl }).catch((caught) => caught);
  assert.equal(error.feishuCode, 234003);
  assert.equal(imageFailureReason(error), "飞书 234003 File not in msg.");

  let resourceCalls = 0;
  const rotated = feishuServer(() => {
    resourceCalls++;
    return resourceCalls === 1
      ? Response.json({ code: 99991663, msg: "invalid token" }, { status: 400 })
      : new Response(PNG, { headers: { "content-type": "image/png" } });
  });
  const file = await downloadFeishuImage({ appId: "cli_rotated", appSecret: "s", brand: "feishu" }, "om_1", "img_x", { fetchImpl: rotated.fetchImpl });
  assert.equal(file.bytes.length, PNG.length);
  assert.equal(resourceCalls, 2);
});

test("an image over the limit is not read, whether or not its size is declared", async () => {
  const creds = { appId: "cli_large", appSecret: "s", brand: "feishu" };
  const declared = feishuServer(() => new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(40 * 1024 * 1024) } }));
  const tooBig = await downloadFeishuImage(creds, "om_1", "img_x", { fetchImpl: declared.fetchImpl }).catch((caught) => caught);
  assert.equal(imageFailureReason(tooBig), "超过 30MB");

  const streamed = feishuServer(() => new Response(new Uint8Array(64), { headers: { "content-type": "image/png" } }));
  const over = await downloadFeishuImage(creds, "om_1", "img_x", { fetchImpl: streamed.fetchImpl, maxBytes: 16 }).catch((caught) => caught);
  assert.equal(over.tooLarge, true);
});

test("each kind of failure reads as its reason", () => {
  assert.equal(imageFailureReason(Object.assign(new Error("t"), { name: "TimeoutError" })), "下载超时");
  assert.equal(imageFailureReason(Object.assign(new Error("x"), { httpStatus: 502 })), "HTTP 502");
  assert.equal(imageFailureReason(Object.assign(new Error("no space"), { code: "ENOSPC" })), "存不下 ENOSPC");
  assert.equal(imageFailureReason(new TypeError("fetch failed")), "网络错误 fetch failed");
});

test(
  "a failed image keeps its place and its reason, the others are saved",
  withDirs(async (root) => {
    const dir = join(root, "images");
    const parts = [
      { type: "text", text: "两张图" },
      { type: "image", n: 1, key: "img_ok" },
      { type: "image", n: 2, key: "img_gone" },
      { type: "skipped", what: "视频" },
    ];
    const logged = [];
    const fetched = await fetchChatImages(parts, {
      messageId: "om_9",
      dir,
      log: (line) => logged.push(line),
      download: async (key) => {
        if (key === "img_gone") {
          throw Object.assign(new Error("gone"), { feishuCode: 234003, detail: "File not in msg." });
        }
        return { bytes: PNG, contentType: "image/png" };
      },
    });
    assert.equal(fetched[1].path, join(dir, "feishu-om_9-1.png"));
    assert.equal(fetched[2].failed, "飞书 234003 File not in msg.");
    assert.match(logged[0], /message om_9 image 2 · not fetched/);
    assert.equal(
      chatPartsPrompt(fetched),
      `两张图\n[图片] ${join(dir, "feishu-om_9-1.png")}\n[图片 没拿到：飞书 234003 File not in msg.]\n[视频 没送：暂不支持]`,
    );
    assert.equal(chatPartsText(fetched), "两张图");
    assert.equal(undeliveredNote(fetched), "第 2 张图片没拿到：飞书 234003 File not in msg.；视频暂不支持，没送");
    assert.equal(chatPartsDeliverable(fetched), true);
    assert.equal(chatPartsDeliverable([fetched[2], fetched[3]]), false);
    assert.equal(attachmentLine({ type: "image", n: 1 }), "[图片 没拿到：没下载]");
  }),
);
