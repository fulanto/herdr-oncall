import assert from "node:assert/strict";
import test from "node:test";
import { pingChannels, replyFeishu, sendRemote, sendTelegram } from "../src/lib/index.mjs";

// The main session's answer to a turn a chat message started goes out as a
// reply to that message, on the channel it came from; anywhere else it is an
// ordinary ping.

test("pingChannels replies only on the channel the turn came from", async () => {
  const sent = [];
  const log = [];
  await pingChannels(["telegram", "feishu"], "done · Claude\nGit-Repo · pane 1\n\n三个编排者都在跑。", {
    status: "done",
    where: "Git-Repo · pane 1",
    replyTo: (channel) => (channel === "feishu" ? "om_user_1" : undefined),
    send: async (channel, _text, options) => {
      sent.push([channel, options.replyTo]);
      return `${channel}-1`;
    },
    log: (line) => log.push(line),
    error: () => {},
  });
  assert.deepEqual(sent, [
    ["telegram", undefined],
    ["feishu", "om_user_1"],
  ]);
  assert.deepEqual(log, ["sent · telegram · Git-Repo · pane 1", "sent · feishu · Git-Repo · pane 1 · as a reply"]);
});

// A stand-in for the Feishu open platform, answering the token call and
// recording every other request.
function feishuServer(answers) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (path.includes("tenant_access_token")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }) };
    }
    requests.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers.find(([prefix]) => path.startsWith(prefix))?.[1] ?? { code: 0, data: {} };
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
  };
  return { requests, fetchImpl };
}

test("a Feishu reply goes to the reply endpoint of the message it answers", async () => {
  const server = feishuServer([["/open-apis/im/v1/messages/om_user_1/reply", { code: 0, data: { message_id: "om_answer" } }]]);
  const id = await replyFeishu({ appId: "cli_reply", appSecret: "s", brand: "feishu" }, "om_user_1", "已完成", {
    fetchImpl: server.fetchImpl,
  });
  assert.equal(id, "om_answer");
  assert.deepEqual(server.requests, [
    { path: "/open-apis/im/v1/messages/om_user_1/reply", body: { msg_type: "text", content: JSON.stringify({ text: "已完成" }) } },
  ]);
});

test("a reply Feishu refuses goes out as an ordinary message", async () => {
  const keys = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_OPEN_ID", "FEISHU_DOMAIN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const errors = [];
  Object.assign(process.env, { FEISHU_APP_ID: "cli_fallback", FEISHU_APP_SECRET: "s", FEISHU_OPEN_ID: "ou_me", FEISHU_DOMAIN: "feishu" });
  const server = feishuServer([
    ["/open-apis/im/v1/messages/om_gone/reply", { code: 230011, msg: "the message was recalled" }],
    ["/open-apis/im/v1/messages?receive_id_type=open_id", { code: 0, data: { message_id: "om_new" } }],
  ]);
  globalThis.fetch = server.fetchImpl;
  console.error = (line) => errors.push(line);
  try {
    const id = await sendRemote("feishu", "done · Claude", { status: "done", replyTo: "om_gone" });
    assert.equal(id, "om_new");
    assert.deepEqual(
      server.requests.map((request) => request.path),
      ["/open-apis/im/v1/messages/om_gone/reply", "/open-apis/im/v1/messages?receive_id_type=open_id"],
    );
    assert.match(errors[0], /^feishu reply failed, sending it as a new message: /);
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

test("a Telegram reply names the message it answers", async () => {
  const previousFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 77 } }) };
  };
  try {
    assert.equal(await sendTelegram("t", "9", "已完成", { forceReply: false, replyTo: "56" }), 77);
    assert.deepEqual(payload.reply_parameters, { message_id: 56, allow_sending_without_reply: true });
    await sendTelegram("t", "9", "已完成", { forceReply: false });
    assert.equal(payload.reply_parameters, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
