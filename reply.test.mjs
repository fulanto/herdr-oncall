import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyDelivery,
  lastOutbound,
  lookupOutbound,
  namedReplyKey,
  rememberOutbound,
  resolveReplyTarget,
} from "./reply.mjs";

test("blocked replies become keys or typed enter", () => {
  assert.deepEqual(classifyDelivery("blocked", "esc"), { mode: "keys", keys: ["esc"] });
  assert.deepEqual(classifyDelivery("blocked", "y"), { mode: "keys", keys: ["y"] });
  assert.deepEqual(classifyDelivery("blocked", "p"), { mode: "keys", keys: ["p"] });
  assert.deepEqual(classifyDelivery("blocked", "Enter"), { mode: "keys", keys: ["enter"] });
  assert.deepEqual(classifyDelivery("blocked", "don't delete that"), { mode: "text-enter" });
});

test("done and idle replies are new prompts", () => {
  assert.deepEqual(classifyDelivery("done", "ship it"), { mode: "prompt" });
  assert.deepEqual(classifyDelivery("idle", "next task"), { mode: "prompt" });
  assert.deepEqual(classifyDelivery("working", "stop"), { mode: "prompt" });
});

test("namedReplyKey maps aliases", () => {
  assert.equal(namedReplyKey("escape"), "esc");
  assert.equal(namedReplyKey("yes"), undefined);
});

test("outbound maps telegram message ids to panes", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-out-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    rememberOutbound(
      { messageId: 42, paneId: "w8:p1", status: "blocked", where: "asr-service · simple" },
      1000,
    );
    const hit = lookupOutbound(42, 1000);
    assert.equal(hit.paneId, "w8:p1");
    assert.equal(lastOutbound(1000).paneId, "w8:p1");
    const byReply = resolveReplyTarget({ reply_to_message: { message_id: 42 } }, 1000);
    assert.equal(byReply.where, "asr-service · simple");
    const bare = resolveReplyTarget({ text: "go" }, 1000);
    assert.equal(bare.paneId, "w8:p1");
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
