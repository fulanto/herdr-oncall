import assert from "node:assert/strict";
import test from "node:test";
import { blockedWaitVerdict, eventGate, pingChannels } from "../src/lib/index.mjs";

// The notify hook's reasons for not pinging, and its record of pinging. A
// colleague's blocked pings stopped reaching Feishu while `test` still did, and
// the plugin log could not say why: every way the hook ended without a ping,
// and the one where it sent it, left the same empty line.

test("eventGate says why a blocked or done event is dropped, and keeps quiet about the rest", () => {
  assert.deepEqual(eventGate("blocked"), { go: true });
  assert.deepEqual(eventGate("done", { notifyOn: "blocked,done" }), { go: true });

  assert.deepEqual(eventGate("blocked", { enabled: false }), {
    go: false,
    reason: "oncall is off (toggled), nothing is sent",
  });
  assert.deepEqual(eventGate("blocked", { notifyOn: "done" }), {
    go: false,
    reason: "blocked is not in NOTIFY_ON=done",
  });
  // working and idle come on every turn; a line for each would bury the log.
  assert.deepEqual(eventGate("working", { enabled: false }), { go: false, reason: "" });
  assert.deepEqual(eventGate("idle"), { go: false, reason: "" });
  assert.deepEqual(eventGate(undefined), { go: false, reason: "" });
});

test("blockedWaitVerdict names why a ping that waited is not sent after all", () => {
  const dialog = "Would you like to run the following command?\n› 1. Yes (y)\n  2. No (esc)";
  assert.equal(blockedWaitVerdict({ stillMine: true, screen: dialog, real: true }), undefined);
  assert.equal(
    blockedWaitVerdict({ stillMine: false, screen: dialog, real: true }),
    "a newer blocked event for this pane took over",
  );
  assert.equal(
    blockedWaitVerdict({ stillMine: true, screen: "› Ask Codex to do anything", real: false }),
    "the dialog left the screen during the wait (answered)",
  );
  assert.equal(
    blockedWaitVerdict({ stillMine: true, screen: "  \n", real: false }),
    "pane screen empty after the wait",
  );
});

test("pingChannels logs every ping sent, and one channel failing does not cost the next its ping", async () => {
  const log = [];
  const error = [];
  const remembered = [];
  const tried = [];
  await pingChannels(["telegram", "feishu"], "blocked · Codex", {
    status: "blocked",
    options: [{ key: "1", send: "y", label: "Yes" }],
    where: "repo · task · pane 2",
    send: async (channel, text, { status, options }) => {
      tried.push([channel, text, status, options.length]);
      if (channel === "telegram") {
        throw new Error("fetch failed");
      }
      return "om_1";
    },
    sent: (channel, messageId) => remembered.push([channel, messageId]),
    log: (line) => log.push(line),
    error: (line) => error.push(line),
  });
  assert.deepEqual(tried, [
    ["telegram", "blocked · Codex", "blocked", 1],
    ["feishu", "blocked · Codex", "blocked", 1],
  ]);
  assert.deepEqual(log, ["sent · feishu · repo · task · pane 2"]);
  assert.deepEqual(error, ["telegram ping failed · repo · task · pane 2: fetch failed"]);
  assert.deepEqual(remembered, [["feishu", "om_1"]]);
});
