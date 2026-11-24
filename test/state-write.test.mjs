import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markBlockedDelay, ownership, rememberPanel, roleSettings, setMode, shouldDebounce } from "../src/lib/index.mjs";
import { armEscalation } from "../src/inbound/escalation.mjs";
import { rememberPendingAnswer, sendFromBoard } from "../src/inbound/main-inbox.mjs";
import { writePollerBinding, writePollerPid } from "../src/inbound/poller.mjs";
import { rememberOutbound } from "../src/inbound/reply.mjs";

// The state dir is shared by every hook, every action and the poller, each a
// process of its own, and any of them can read a file while another writes it.
// A write that empties the file and then fills it leaves a moment in which the
// file is there and empty, and every reader takes an empty file for "nothing
// on record": an empty poller.pid read as "no poller is running", an empty
// store as {}, which the reader then wrote back without anyone else's records.
// On a busy machine that moment was hit: poller.pid, read while the poller
// that had just come up was writing its own pid into it, came back as 0.
//
// The moment itself cannot be held open from a test. What makes it possible
// can be seen, though: a writer working on the very file a reader has open.
// One that puts a whole new file in its place leaves that reader with the
// record it opened, and the next reader with the new one.

const A = "/oncall-test/state-write/herdr.sock";
const B = "/oncall-test/state-write/sessions/other/herdr.sock";
const PANE = "w1:p1";
const DROVER = roleSettings({ MAIN_AGENT_NAME: "drover", BARE_MESSAGE_TARGET: "main" });

// The main session is in a dialog, so a click from the task board waits in the
// inbox instead of going in.
function mainInDialog(args) {
  if (args[0] === "agent" && args[1] === "list") {
    const agents = [{ name: "drover", pane_id: PANE, agent: "claude", agent_status: "blocked" }];
    return { status: 0, stdout: JSON.stringify({ result: { agents } }) };
  }
  return { status: 0, stdout: "" };
}

function click(text) {
  return sendFromBoard(text, { settings: DROVER, run: mainInDialog, enabled: true, log: () => {}, owned: () => ({ mine: true, socket: A }) });
}

// Every state file that one process writes while another may read it, each
// with two writes through the code that really writes it.
const WRITES = {
  "poller.pid": [() => writePollerPid(4242), () => writePollerPid(5151)],
  "poller.json": [() => writePollerBinding({ pid: 4242, socket: A }), () => writePollerBinding({ pid: 5151, socket: A })],
  "owner.json": [() => ownership({ claim: "poll", env: { HERDR_SOCKET_PATH: A } }), () => ownership({ claim: "poll", env: { HERDR_SOCKET_PATH: B } })],
  "outbound.json": [
    () => rememberOutbound({ messageId: "om_1", paneId: PANE, status: "done" }),
    () => rememberOutbound({ messageId: "om_2", paneId: PANE, status: "done" }),
  ],
  "escalations.json": [
    () => armEscalation({ paneId: PANE, role: "worker", name: "api-e2e", fingerprint: "one" }),
    () => armEscalation({ paneId: PANE, role: "worker", name: "api-e2e", fingerprint: "two" }),
  ],
  "main-inbox.json": [() => click("first"), () => click("second")],
  "main-pending.json": [
    () => rememberPendingAnswer({ paneId: PANE, channel: "feishu", messageId: "om_1", text: "one" }),
    () => rememberPendingAnswer({ paneId: PANE, channel: "feishu", messageId: "om_2", text: "two" }),
  ],
  "panels.json": [() => rememberPanel(PANE, 4242, "blocked"), () => rememberPanel(PANE, 5151, "blocked")],
  "last-notify.json": [() => shouldDebounce(PANE, "blocked"), () => shouldDebounce(PANE, "done")],
  "blocked-delay.json": [() => markBlockedDelay(PANE, 1), () => markBlockedDelay(PANE, 2)],
  enabled: [() => setMode(false), () => setMode(true)],
};

const SANDBOXED = ["HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR", "HERDR_SOCKET_PATH"];

async function inSandbox(body) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-state-write-"));
  const previous = SANDBOXED.map((key) => [key, process.env[key]]);
  // Not there yet: whoever writes first has to make it.
  const state = join(dir, "state");
  process.env.HERDR_PLUGIN_STATE_DIR = state;
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(dir, "config");
  process.env.HERDR_SOCKET_PATH = A;
  try {
    await body(state);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [file, [first, second]] of Object.entries(WRITES)) {
  test(`${file}: a reader that has it open while it is written still reads a whole record`, () =>
    inSandbox(async (state) => {
      await first();
      const path = join(state, file);
      const before = readFileSync(path, "utf8");
      assert.ok(before, "the first write is on file");

      const held = openSync(path, "r");
      let seen;
      try {
        await second();
        seen = readFileSync(held, "utf8");
      } finally {
        closeSync(held);
      }

      assert.notEqual(readFileSync(path, "utf8"), before, "the second write is what a new reader gets");
      assert.equal(seen, before, "the reader that had the file open got the record it opened, whole");
      assert.deepEqual(
        readdirSync(state).filter((name) => name.startsWith(`${file}.`)),
        [],
        "nothing is left beside the file",
      );
    }));
}
