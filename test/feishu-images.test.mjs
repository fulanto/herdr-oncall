import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeChatAnswer, dialogFingerprint, roleSettings } from "../src/lib/index.mjs";
import { handleFeishuEvent, parseFeishuMessage } from "../src/inbound/feishu.mjs";
import { drainInbox, pendingAnswers, readInbox } from "../src/inbound/main-inbox.mjs";
import { lookupOutbound, rememberOutbound } from "../src/inbound/reply.mjs";

// What a Feishu message with images does, from the event on the long
// connection to the herdr call, with Feishu and herdr as stand-ins and the
// config, state and image directories in a temp dir.

const DROVER = roleSettings({ MAIN_AGENT_NAME: "drover", BARE_MESSAGE_TARGET: "main" });
const NO_DROVER = roleSettings({});
const MAIN = "w1Z:p1";
const WORKER = "w8:p1";

// A real 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const IDLE = ["⏺ 进度：三个编排者都在跑。", "", "────────", "❯ ", "────────", "  ⏵⏵ auto mode on"].join("\n");
const DIALOG = [
  "⏺ Bash(git push origin main)",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "  Esc to cancel · Tab to amend",
].join("\n");

function withDirs(body, { imageDir = true } = {}) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "oncall-feishu-images-"));
    const keys = ["HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR", "CHAT_IMAGE_DIR"];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.HERDR_PLUGIN_STATE_DIR = join(root, "state");
    process.env.HERDR_PLUGIN_CONFIG_DIR = join(root, "config");
    if (imageDir) {
      process.env.CHAT_IMAGE_DIR = join(root, "oncall-images");
    } else {
      delete process.env.CHAT_IMAGE_DIR;
    }
    try {
      await body({ root, images: imageDir ? join(root, "oncall-images") : join(root, "state", "chat-images") });
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}

// herdr as a recorder: the main session named drover on MAIN, other panes by
// their screen and status.
function herdrStub({ main = { agent: "claude", agent_status: "idle" }, screens = {}, statuses = {} } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const [group, verb, pane] = args;
    if (group === "agent" && verb === "list") {
      const agents = main ? [{ name: "drover", pane_id: MAIN, ...main }] : [];
      return { status: 0, stdout: JSON.stringify({ result: { agents } }) };
    }
    if (group === "pane" && verb === "read") {
      const text = screens[pane] ?? IDLE;
      return { status: 0, stdout: args.includes("ansi") ? text : JSON.stringify({ result: { read: { text } } }) };
    }
    if (group === "pane" && verb === "get") {
      const state = statuses[pane] ?? (pane === MAIN ? main?.agent_status : "idle");
      return { status: 0, stdout: JSON.stringify({ result: { agent: { state } } }) };
    }
    return { status: 0, stdout: "{}" };
  };
  const prompts = () => calls.filter((args) => args[0] === "agent" && args[1] === "prompt").map((args) => args.slice(2));
  const typed = () => calls.filter((args) => args[1] === "send-keys" || args[1] === "send-text" || (args[0] === "agent" && args[1] === "prompt"));
  return { run, calls, prompts, typed };
}

// Feishu's two endpoints a received image touches: the tenant token, and the
// message resource, answered by `resource(url)`.
function feishuServer(resource = () => new Response(PNG, { headers: { "content-type": "image/png" } })) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/auth/v3/tenant_access_token/internal")) {
      return Response.json({ code: 0, tenant_access_token: "t-1", expire: 7200 });
    }
    return resource(String(url));
  };
  return { fetchImpl, calls };
}

function deps(herdr, said, extra = {}) {
  return {
    creds: { appId: "cli_1", appSecret: "s", brand: "feishu" },
    openId: "ou_me",
    seen: new Map(),
    run: herdr.run,
    wait: async () => {},
    settings: DROVER,
    enabled: true,
    fetchImpl: feishuServer().fetchImpl,
    send: async (_creds, _openId, text) => {
      said.push(text);
      return `om_${said.length + 100}`;
    },
    channelFor: () => undefined,
    ...extra,
  };
}

let count = 0;
// An im.message.receive_v1 event as the long connection delivers it.
function received(messageType, content, { parent = "", mentions } = {}) {
  count++;
  return {
    schema: "2.0",
    header: {
      event_id: `ev-img-${count}`,
      event_type: "im.message.receive_v1",
      create_time: "1763452800000",
      token: "",
      app_id: "cli_1",
      tenant_key: "tk_1",
    },
    event: {
      sender: { sender_id: { open_id: "ou_me", union_id: "on_me", user_id: "u_me" }, sender_type: "user", tenant_key: "tk_1" },
      message: {
        message_id: `om_img_${count}`,
        root_id: parent,
        parent_id: parent,
        create_time: "1763452800000",
        update_time: "1763452800000",
        chat_id: "oc_p2p",
        chat_type: "p2p",
        message_type: messageType,
        content: JSON.stringify(content),
        ...(mentions ? { mentions } : {}),
        user_agent: "Mozilla/5.0 Lark/7.40.0",
      },
    },
  };
}

async function run(envelope, dependencies) {
  const outcome = handleFeishuEvent(envelope, dependencies);
  assert.equal(outcome.response, undefined, "a message needs no answer in its ack");
  return outcome.work ? outcome.work() : outcome;
}

// ---------------------------------------------------------------------------

test("a post reads line by line: title, links, mentions, code, emoji, images in place, a video as not sent", () => {
  const { parts } = parseFeishuMessage({
    message_type: "post",
    mentions: [{ key: "@_user_1", id: { open_id: "ou_zhang" }, name: "张三", tenant_key: "tk_1" }],
    content: JSON.stringify({
      title: "线上报错",
      content: [
        [
          { tag: "text", text: "看下", style: [] },
          { tag: "text", text: "这两张", style: ["bold"] },
          { tag: "emotion", emoji_type: "SMILE" },
        ],
        [{ tag: "img", image_key: "img_1", width: 800, height: 600 }],
        [
          { tag: "at", user_id: "@_user_1", user_name: "", style: [] },
          { tag: "text", text: " 文档见 " },
          { tag: "a", href: "https://example.com/doc", text: "设计稿", style: [] },
          { tag: "text", text: " 和 " },
          { tag: "a", href: "https://example.com/raw", text: "https://example.com/raw" },
        ],
        [],
        [{ tag: "code_block", language: "GO", text: "func main() int64 {\n    return 0\n}\n" }],
        [{ tag: "hr" }],
        [
          { tag: "text", text: "录屏：" },
          { tag: "media", file_key: "file_v2_1", image_key: "img_cover" },
          { tag: "text", text: "第二张：" },
          { tag: "img", image_key: "img_2" },
        ],
      ],
    }),
  });
  assert.deepEqual(parts, [
    { type: "text", text: "线上报错\n看下这两张[SMILE]" },
    { type: "image", n: 1, key: "img_1" },
    {
      type: "text",
      text: "@张三 文档见 设计稿 (https://example.com/doc) 和 https://example.com/raw\n\n```go\nfunc main() int64 {\n    return 0\n}\n```\n---\n录屏：",
    },
    { type: "skipped", what: "视频" },
    { type: "text", text: "第二张：" },
    { type: "image", n: 2, key: "img_2" },
  ]);
});

test("a post written in Markdown is read from content_v2, which keeps it", () => {
  const { parts } = parseFeishuMessage({
    message_type: "post",
    mentions: [{ key: "@_user_1", id: { open_id: "ou_li" }, name: "李四" }],
    content: JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "第一行:" }, { tag: "a", href: "http://www.feishu.cn", text: "超链接" }]],
      content_v2: [
        [{ tag: "md", text: '**第一行:**[超链接](http://www.feishu.cn)<at user_id="ou_li"></at>' }],
        [{ tag: "img", image_key: "img_md" }],
      ],
    }),
  });
  assert.deepEqual(parts, [
    { type: "text", text: "**第一行:**[超链接](http://www.feishu.cn)@李四" },
    { type: "image", n: 1, key: "img_md" },
  ]);
  // Without md, content is read as before.
  const plain = parseFeishuMessage({
    message_type: "post",
    content: JSON.stringify({ content: [[{ tag: "text", text: "a" }]], content_v2: [[{ tag: "text", text: "a" }]] }),
  });
  assert.deepEqual(plain.parts, [{ type: "text", text: "a" }]);
});

test(
  "end to end: a post of words and an image reaches the main session as the words and a real PNG's path",
  withDirs(async ({ images }) => {
    const herdr = herdrStub();
    const said = [];
    const server = feishuServer();
    const envelope = received("post", {
      title: "",
      content: [
        [{ tag: "text", text: "这张图里画的是什么？", style: [] }],
        [{ tag: "img", image_key: "img_v3_02ab", width: 1, height: 1 }],
      ],
    });
    const outcome = await run(envelope, deps(herdr, said, { fetchImpl: server.fetchImpl }));
    assert.equal(outcome.delivered, true);
    const path = join(images, `feishu-${envelope.event.message.message_id}-1.png`);
    assert.deepEqual(herdr.prompts(), [[MAIN, `[飞书] 这张图里画的是什么？\n[图片] ${path}`]]);
    assert.ok(existsSync(path));
    assert.deepEqual(readFileSync(path), PNG);
    assert.equal(
      server.calls.at(-1),
      `https://open.feishu.cn/open-apis/im/v1/messages/${envelope.event.message.message_id}/resources/img_v3_02ab?type=image`,
    );
    assert.deepEqual(said, ["已送达主会话"]);

    // The answer is found in the session record by the text that went in,
    // image line and all, exactly as Claude Code keeps the user's prompt.
    const [waiting] = pendingAnswers(MAIN);
    assert.equal(waiting.text, `[飞书] 这张图里画的是什么？\n[图片] ${path}`);
    const records = [
      { type: "user", timestamp: new Date(waiting.deliveredAt).toISOString(), message: { role: "user", content: waiting.text } },
      { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "一个像素。" }] } },
    ];
    assert.deepEqual(claudeChatAnswer(records, { text: waiting.text, after: waiting.deliveredAt }), { state: "answered", answer: "一个像素。" });
  }),
);

test(
  "end to end: an image on its own goes in as an image line, and with CHAT_IMAGE_DIR unset it lands in the state dir",
  withDirs(
    async ({ images }) => {
      const herdr = herdrStub();
      const said = [];
      const envelope = received("image", { image_key: "img_v3_solo" });
      const outcome = await run(envelope, deps(herdr, said));
      assert.equal(outcome.delivered, true);
      const path = join(images, `feishu-${envelope.event.message.message_id}-1.png`);
      assert.deepEqual(herdr.prompts(), [[MAIN, `[飞书] [图片] ${path}`]]);
      assert.deepEqual(readFileSync(path), PNG);
      assert.deepEqual(said, ["已送达主会话"]);
    },
    { imageDir: false },
  ),
);

test(
  "an image that cannot be fetched is marked where it was; the words still go in and the reply says which one",
  withDirs(async () => {
    const herdr = herdrStub();
    const said = [];
    const refused = feishuServer(() => Response.json({ code: 234003, msg: "File not in msg." }, { status: 400 }));
    await run(
      received("post", { content: [[{ tag: "text", text: "看下这个报错" }], [{ tag: "img", image_key: "img_gone" }]] }),
      deps(herdr, said, { fetchImpl: refused.fetchImpl }),
    );
    assert.deepEqual(herdr.prompts(), [[MAIN, "[飞书] 看下这个报错\n[图片 没拿到：飞书 234003 File not in msg.]"]]);
    assert.deepEqual(said, ["已送达主会话（第 1 张图片没拿到：飞书 234003 File not in msg.）"]);

    // Nothing else in the message: nothing is typed, and the reply says why.
    const offline = feishuServer(() => {
      throw new TypeError("fetch failed");
    });
    const outcome = await run(received("image", { image_key: "img_x" }), deps(herdr, said, { fetchImpl: offline.fetchImpl }));
    assert.deepEqual(outcome, { skipped: "nothing-to-send" });
    assert.equal(herdr.prompts().length, 1);
    assert.equal(said.at(-1), "没送进去：第 1 张图片没拿到：网络错误 fetch failed");
  }),
);

test(
  "a kind of message that cannot go in is answered, not dropped; a video inside a post is marked and the rest goes in",
  withDirs(async ({ images }) => {
    const herdr = herdrStub();
    const said = [];
    const replies = {
      file: "暂不支持文件，没送进去",
      audio: "暂不支持音频，没送进去",
      media: "暂不支持视频，没送进去",
      sticker: "暂不支持表情包，没送进去",
      merge_forward: "暂不支持合并转发的消息，没送进去",
      interactive: "暂不支持卡片，没送进去",
      share_chat: "暂不支持群名片，没送进去",
      brand_new_type: "暂不支持这类消息（brand_new_type），没送进去",
    };
    for (const [type, reply] of Object.entries(replies)) {
      const outcome = await run(received(type, { file_key: "file_1" }), deps(herdr, said));
      assert.equal(outcome.skipped, "unsupported");
      assert.equal(said.at(-1), reply);
    }
    assert.deepEqual(herdr.typed(), []);
    assert.ok(!/\p{Extended_Pictographic}/u.test(said.join("\n")), "plain text, no emoji");

    // A post with nothing in it is answered too.
    await run(received("post", { title: "", content: [[]] }), deps(herdr, said));
    assert.equal(said.at(-1), "没送进去：消息里没有能送的内容");

    const envelope = received("post", {
      content: [
        [{ tag: "text", text: "录屏和截图" }],
        [{ tag: "media", file_key: "file_v2_1", image_key: "img_cover" }],
        [{ tag: "img", image_key: "img_shot" }],
      ],
    });
    await run(envelope, deps(herdr, said));
    const path = join(images, `feishu-${envelope.event.message.message_id}-1.png`);
    assert.deepEqual(herdr.prompts(), [[MAIN, `[飞书] 录屏和截图\n[视频 没送：暂不支持]\n[图片] ${path}`]]);
    assert.equal(said.at(-1), "已送达主会话（视频暂不支持，没送）");
  }),
);

test(
  "words past 2000 characters are cut, the image lines are not",
  withDirs(async ({ images }) => {
    const herdr = herdrStub();
    const said = [];
    const envelope = received("post", {
      content: [
        [{ tag: "text", text: "长".repeat(1500) }],
        [{ tag: "img", image_key: "img_a" }],
        [{ tag: "text", text: "文".repeat(1000) }],
        [{ tag: "img", image_key: "img_b" }],
        [{ tag: "text", text: "尾巴" }],
      ],
    });
    await run(envelope, deps(herdr, said));
    const id = envelope.event.message.message_id;
    const [[, text]] = herdr.prompts();
    const lines = text.split("\n");
    assert.deepEqual(lines, [
      `[飞书] ${"长".repeat(1500)}`,
      `[图片] ${join(images, `feishu-${id}-1.png`)}`,
      "文".repeat(500),
      `[图片] ${join(images, `feishu-${id}-2.png`)}`,
    ]);
    assert.equal(said.at(-1), "已送达主会话（超过 2000 字，只送了前 2000 字）");
  }),
);

test(
  "an image is never an answer to a dialog: a quoted card is refused and stays usable",
  withDirs(async () => {
    const herdr = herdrStub({ main: { agent: "claude", agent_status: "blocked" }, screens: { [MAIN]: DIALOG } });
    const said = [];
    rememberOutbound({
      messageId: "om_dialog",
      paneId: MAIN,
      status: "blocked",
      where: "projects · pane 1",
      fingerprint: dialogFingerprint(DIALOG),
      options: [{ key: "1", send: "1", label: "Yes" }],
    });
    const outcome = await run(
      received("post", { content: [[{ tag: "text", text: "1" }], [{ tag: "img", image_key: "img_1" }]] }, { parent: "om_dialog" }),
      deps(herdr, said),
    );
    assert.equal(outcome.refused, "image");
    assert.deepEqual(herdr.typed(), []);
    assert.deepEqual(said, ["确认框只能用文字或按钮回答，这条带图片，没送 · projects · pane 1"]);
    assert.equal(lookupOutbound("om_dialog").spent, undefined, "the card can still be tapped");

    // A message of words alone still answers it.
    await run(received("text", { text: "1" }, { parent: "om_dialog" }), deps(herdr, said));
    assert.deepEqual(herdr.typed().map((args) => args.join(" ")), [`pane send-keys ${MAIN} 1`]);
  }),
);

test(
  "a main session waiting on a dialog keeps the message, image line and all, and the reminder shows no path",
  withDirs(async ({ images }) => {
    const state = { agent: "claude", agent_status: "blocked" };
    const herdr = herdrStub({ main: state, screens: { [MAIN]: DIALOG } });
    const said = [];
    const envelope = received("image", { image_key: "img_wait" });
    await run(envelope, deps(herdr, said, { now: 0 }));
    const path = join(images, `feishu-${envelope.event.message.message_id}-1.png`);
    assert.deepEqual(herdr.typed(), []);
    assert.equal(readInbox()[0].text, `[飞书] [图片] ${path}`);
    assert.match(said.at(-1), /你这条已暂存/);

    const channel = { name: "feishu", reply: async (text) => said.push(text) };
    await drainInbox({ channelFor: () => channel, settings: DROVER, run: herdr.run, now: 31 * 60_000, enabled: true, log: () => {} });
    assert.equal(said.at(-1), "还没送进去：「[飞书] [图片]」（主会话在等确认：Do you want to proceed?），仍在暂存");

    state.agent_status = "idle";
    const idle = herdrStub({ main: state });
    await drainInbox({ channelFor: () => channel, settings: DROVER, run: idle.run, now: 32 * 60_000, enabled: true, log: () => {} });
    assert.deepEqual(idle.prompts(), [[MAIN, `[飞书] [图片] ${path}`]]);
  }),
);

test(
  "a command with an image is neither run nor sent",
  withDirs(async () => {
    const herdr = herdrStub();
    const said = [];
    const outcome = await run(
      received("post", { content: [[{ tag: "text", text: "/off" }], [{ tag: "img", image_key: "img_1" }]] }),
      deps(herdr, said, { setEnabled: () => assert.fail("not run") }),
    );
    assert.deepEqual(outcome, { skipped: "command-with-image" });
    assert.deepEqual(said, ["以 / 开头的是命令，命令不能带图片，这条没执行也没送"]);
    assert.deepEqual(herdr.typed(), []);
  }),
);

test(
  "without drover the same message goes to the latest ping's pane, unprefixed, and a pane asking something refuses it",
  withDirs(async ({ images }) => {
    const herdr = herdrStub({ screens: { [WORKER]: IDLE }, statuses: { [WORKER]: "done" } });
    const said = [];
    rememberOutbound({ messageId: "om_done", paneId: WORKER, status: "done", where: "api-service · main" });
    const envelope = received("post", { content: [[{ tag: "text", text: "照这个改" }], [{ tag: "img", image_key: "img_1" }]] });
    await run(envelope, deps(herdr, said, { settings: NO_DROVER }));
    const path = join(images, `feishu-${envelope.event.message.message_id}-1.png`);
    assert.deepEqual(herdr.prompts(), [[WORKER, `照这个改\n[图片] ${path}`]]);
    assert.deepEqual(said, ["sent · api-service · main"]);
    assert.ok(!herdr.calls.some((args) => args[0] === "agent" && args[1] === "list"), "no main session without drover");

    // The same pane now on a dialog: a bare message with an image is refused.
    const blocked = herdrStub({ screens: { [WORKER]: DIALOG }, statuses: { [WORKER]: "blocked" } });
    const outcome = await run(received("image", { image_key: "img_2" }), deps(blocked, said, { settings: NO_DROVER }));
    assert.equal(outcome.refused, "image");
    assert.deepEqual(blocked.typed(), []);
    assert.equal(said.at(-1), "确认框只能用文字或按钮回答，这条带图片，没送 · api-service · main");
  }),
);
