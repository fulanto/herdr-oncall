import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyDelivery,
  deliverReply,
  handleTelegramUpdate,
  herdrErrorText,
  herdrFailed,
  lastOutbound,
  lookupOutbound,
  namedReplyKey,
  rememberOutbound,
  replyFingerprint,
  resolveReplyTarget,
} from "../src/inbound/reply.mjs";
import { dialogFingerprint } from "../src/lib/index.mjs";

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

const DIALOG = [
  "⏺ Bash(rm -rf -- /tmp/draft)",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "  Esc to cancel · Tab to amend",
].join("\n");

// The dialog that replaced it: a different question and a different set of
// choices, so "1" means something else now.
const NEXT_DIALOG = [
  "⏺ Bash(git push --force)",
  "",
  "  Do you want to force-push to main?",
  "  ❯ 1. Yes",
  "    2. Yes, and don't ask again for git push",
  "    3. No",
  "",
  "  Esc to cancel · Tab to amend",
].join("\n");

// A herdr stand-in: records every argv, reports the pane blocked, and serves
// whatever screen the test says is on it now.
function fakeHerdr(screen, calls) {
  return (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent: { state: "blocked" } } }) };
    }
    if (args[1] === "read") {
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: screen } } }) };
    }
    return { status: 0, stdout: "" };
  };
}

test("outbound remembers what the dialog was asking", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-fp-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    const fingerprint = dialogFingerprint(DIALOG);
    rememberOutbound(
      {
        messageId: 7,
        paneId: "w8:p1",
        status: "blocked",
        where: "asr-service · main",
        fingerprint,
        options: [{ key: "1", send: "1", label: "Yes" }],
      },
      1000,
    );
    const hit = lookupOutbound(7, 1000);
    assert.equal(hit.fingerprint, fingerprint);
    assert.deepEqual(hit.options, [{ key: "1", send: "1", label: "Yes" }]);
    assert.equal(lastOutbound(1000).fingerprint, fingerprint);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a button tapped after the dialog changed presses nothing", () => {
  const calls = [];
  const result = deliverReply("w8:p1", "1", "blocked", {
    fingerprint: dialogFingerprint(DIALOG),
    run: fakeHerdr(NEXT_DIALOG, calls),
  });
  assert.equal(result.stale, true);
  assert.equal(herdrFailed(result), true);
  assert.match(herdrErrorText(result), /dialog changed since this ping/);
  assert.equal(
    calls.some((call) => call.includes("send-keys") || call.includes("send-text") || call.includes("prompt")),
    false,
    "nothing may reach the pane",
  );
});

test("a reply to a dialog that is still up goes through", () => {
  const calls = [];
  const result = deliverReply("w8:p1", "1", "blocked", {
    fingerprint: dialogFingerprint(DIALOG),
    run: fakeHerdr(DIALOG, calls),
  });
  assert.equal(result.stale, undefined);
  assert.equal(herdrFailed(result), false);
  assert.equal(calls.at(-1), "pane send-keys w8:p1 1");
});

test("a dialog that is gone entirely is stale too", () => {
  const calls = [];
  const idle = ["⏺ done.", "", "❯", "  ➜ repo git:(main) ctx:20% Opus 5"].join("\n");
  const result = deliverReply("w8:p1", "esc", "blocked", {
    fingerprint: dialogFingerprint(DIALOG),
    run: fakeHerdr(idle, calls),
  });
  assert.equal(result.stale, true);
  assert.equal(
    calls.some((call) => call.includes("send-keys")),
    false,
  );
});

test("no fingerprint and an unreadable pane both keep the old behaviour", () => {
  const legacy = [];
  // Records written before fingerprints existed carry none: send as before.
  assert.equal(herdrFailed(deliverReply("w8:p1", "y", "blocked", { run: fakeHerdr(NEXT_DIALOG, legacy) })), false);
  assert.equal(legacy.at(-1), "pane send-keys w8:p1 y");
  assert.equal(
    legacy.some((call) => call.includes("read")),
    false,
    "no fingerprint means no extra pane read",
  );

  // Herdr cannot read the pane: refusing every reply would be worse than sending.
  const blind = [];
  const run = (args) => {
    blind.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent: { state: "blocked" } } }) };
    }
    if (args[1] === "read") {
      return { status: 1, stdout: "", stderr: "pane not found" };
    }
    return { status: 0, stdout: "" };
  };
  const result = deliverReply("w8:p1", "y", "blocked", { fingerprint: dialogFingerprint(DIALOG), run });
  assert.equal(result.stale, undefined);
  assert.equal(blind.at(-1), "pane send-keys w8:p1 y");
});

test("a done ping is never fingerprint-checked", () => {
  const calls = [];
  // Even handed a real fingerprint: a done ping is about the pane, not about a
  // dialog, so nothing on screen can make the new instruction stale.
  const result = deliverReply("w8:p1", "ship it", "done", {
    fingerprint: dialogFingerprint(DIALOG),
    run: (args) => {
      calls.push(args.join(" "));
      if (args[0] === "pane" && args[1] === "get") {
        return { status: 0, stdout: JSON.stringify({ result: { agent_status: "idle" } }) };
      }
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(herdrFailed(result), false);
  assert.equal(calls.at(-1), "agent prompt w8:p1 ship it");
  assert.equal(
    calls.some((call) => call.includes("read")),
    false,
    "no dialog to verify means no pane read",
  );
});

test("a tap is checked against the screen even while herdr calls the pane working", () => {
  // `pane get` lags behind the terminal: the next dialog is already drawn while
  // herdr still reports the previous state. Gating the check on the live status
  // is what let a stale tap through as a prompt.
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent_status: "working" } }) };
    }
    if (args[1] === "read") {
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: NEXT_DIALOG } } }) };
    }
    return { status: 0, stdout: "" };
  };
  const result = deliverReply("w8:p1", "1", "blocked", {
    fingerprint: dialogFingerprint(DIALOG),
    run,
  });
  assert.equal(result.stale, true);
  assert.equal(
    calls.some((call) => call.includes("agent prompt")),
    false,
    "a stale tap must not become a prompt either",
  );
});

test("herdr contradicting a stale pane status re-opens the dialog check", () => {
  // `pane get` still reports the previous detection pass, so the reply is
  // classified as a prompt; `agent prompt` then says agent_blocked, which means
  // a dialog is up after all — and it is not the one this button belonged to.
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent_status: "working" } }) };
    }
    if (args[1] === "read") {
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: NEXT_DIALOG } } }) };
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      return { status: 1, stdout: "", stderr: "pane is agent_blocked" };
    }
    return { status: 0, stdout: "" };
  };
  const result = deliverReply("w8:p1", "1", "blocked", {
    fingerprint: dialogFingerprint(DIALOG),
    run,
  });
  assert.equal(result.stale, true);
  assert.equal(
    calls.some((call) => call.includes("send-text") || call.includes("send-keys")),
    false,
    "the fallback must not type into a dialog it was never shown",
  );
});

test("the same fallback still delivers when the dialog matches", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent_status: "working" } }) };
    }
    if (args[1] === "read") {
      return { status: 0, stdout: JSON.stringify({ result: { read: { text: DIALOG } } }) };
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      return { status: 1, stdout: "", stderr: "pane is agent_blocked" };
    }
    return { status: 0, stdout: "" };
  };
  const result = deliverReply("w8:p1", "keep going", "blocked", {
    fingerprint: dialogFingerprint(DIALOG),
    run,
  });
  assert.equal(herdrFailed(result), false);
  assert.deepEqual(calls.slice(-2), [
    "pane send-text w8:p1 keep going",
    "pane send-keys w8:p1 enter",
  ]);
});

// The pane after the dialog was answered in the terminal: nothing is waiting.
const MOVED_ON = ["⏺ removed /tmp/draft.", "", "❯", "  ➜ repo git:(main) ctx:20% Opus 5"].join("\n");

async function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-inbound-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Telegram and herdr as recorders, so the whole inbound path runs offline.
function inboundDeps(screen, calls, sent) {
  return {
    token: "t",
    chatId: "55",
    send: async (_token, _chat, text) => {
      sent.push(text);
    },
    answer: async () => {},
    run: (args) => {
      calls.push(args.join(" "));
      if (args[0] === "pane" && args[1] === "get") {
        return { status: 0, stdout: JSON.stringify({ result: { agent_status: "idle" } }) };
      }
      if (args[1] === "read") {
        return { status: 0, stdout: JSON.stringify({ result: { read: { text: screen } } }) };
      }
      return { status: 0, stdout: "" };
    },
  };
}

test("an explicit reply is bound to its dialog, a bare message is not", async () => {
  await withStateDir(async () => {
    rememberOutbound({
      messageId: 7,
      paneId: "w8:p1",
      status: "blocked",
      where: "asr-service · main",
      fingerprint: dialogFingerprint(DIALOG),
      options: [{ key: "1", send: "1", label: "Yes" }],
    });

    // Replying to that ping means answering that dialog — and it is gone.
    const explicitCalls = [];
    const explicitSent = [];
    const explicit = await handleTelegramUpdate(
      { message: { text: "1", chat: { id: 55 }, reply_to_message: { message_id: 7 } } },
      inboundDeps(MOVED_ON, explicitCalls, explicitSent),
    );
    assert.equal(explicit.stale, true);
    assert.match(explicitSent.at(-1), /^stale · asr-service · main · dialog changed, not sent$/);
    assert.equal(
      explicitCalls.some((call) => call.includes("send-keys") || call.includes("agent prompt")),
      false,
    );

    // The same record reached by a bare message is just "the pane I last heard
    // from": a new instruction, with no dialog to verify.
    const bareCalls = [];
    const bareSent = [];
    const bare = await handleTelegramUpdate(
      { message: { text: "start the next task", chat: { id: 55 } } },
      inboundDeps(MOVED_ON, bareCalls, bareSent),
    );
    assert.equal(bare.ok, true);
    assert.equal(bareCalls.at(-1), "agent prompt w8:p1 start the next task");
    assert.equal(
      bareCalls.some((call) => call.includes("read")),
      false,
      "a bare message is about the pane, so nothing is fingerprint-checked",
    );
    assert.match(bareSent.at(-1), /^sent · /);
  });
});

test("resolveReplyTarget says which replies carry a fingerprint", async () => {
  await withStateDir(() => {
    const fingerprint = dialogFingerprint(DIALOG);
    rememberOutbound({ messageId: 7, paneId: "w8:p1", status: "blocked", fingerprint });
    const explicit = resolveReplyTarget({ reply_to_message: { message_id: 7 } });
    assert.equal(explicit.explicit, true);
    assert.equal(replyFingerprint(explicit), fingerprint);
    const bare = resolveReplyTarget({ text: "go" });
    assert.equal(bare.explicit, false);
    assert.equal(replyFingerprint(bare), undefined);
  });
});

test("a button tap that names an unknown message reaches no pane", async () => {
  await withStateDir(async () => {
    rememberOutbound({
      messageId: 7,
      paneId: "w8:p1",
      status: "blocked",
      where: "asr-service · main",
      fingerprint: dialogFingerprint(DIALOG),
    });
    const calls = [];
    const sent = [];
    // The record above is the most recent ping: falling back to it would press
    // "1" into a pane this button was never about.
    const result = await handleTelegramUpdate(
      {
        callback_query: {
          id: "cb1",
          data: "1",
          from: { id: 55 },
          message: { message_id: 999, chat: { id: 55 } },
        },
      },
      inboundDeps(DIALOG, calls, sent),
    );
    assert.deepEqual(result, { skipped: "no-target" });
    assert.deepEqual(calls, [], "nothing may reach herdr at all");
    assert.deepEqual(sent, ["no pane mapped for that button"]);
  });
});
