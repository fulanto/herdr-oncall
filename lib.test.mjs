import assert from "node:assert/strict";
import test from "node:test";
import { formatMessage, notifyStatuses, shouldNotify } from "./lib.mjs";

test("v1 default notify list is blocked only", () => {
  assert.deepEqual(notifyStatuses(undefined), ["blocked"]);
  assert.deepEqual(notifyStatuses("blocked, done"), ["blocked", "done"]);
});

test("shouldNotify respects the allow list", () => {
  assert.equal(shouldNotify("blocked"), true);
  assert.equal(shouldNotify("done"), false);
  assert.equal(shouldNotify("working"), false);
  assert.equal(shouldNotify("done", "blocked,done"), true);
});

test("formatMessage names workspace, pane, and status without emoji", () => {
  const text = formatMessage(
    { workspace_label: "货架", tab_label: "1", focused_pane_agent: "claude" },
    { data: { pane_id: "w1:p2", agent_status: "blocked", display_agent: "claude" } },
    "blocked",
  );
  assert.match(text, /^blocked · Claude/m);
  assert.match(text, /货架 · w1:p2/);
  assert.match(text, /waiting for input/);
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(text), false);
});
