import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dialogFingerprint, roleSettings, screenHasLiveDialog } from "../src/lib/index.mjs";
import { armEscalation, checkEscalations, readEscalations } from "../src/inbound/escalation.mjs";

const DROVER = roleSettings({
  MAIN_AGENT_NAME: "drover",
  SUPERVISOR_ESCALATE_SEC: "300",
  SUPERVISOR_ESCALATE_SEC_CODEX: "120",
  SUPERVISED_ESCALATE_SEC: "600",
});

const DIALOG = [
  "⏺ Bash(podman machine list)",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. Yes, and don't ask again for podman commands",
  "    3. No",
  "",
  "  Esc to cancel · Tab to amend",
].join("\n");

// The next dialog of the same pane: another command, so another fingerprint.
const NEXT_DIALOG = DIALOG.replace("podman machine list", "podman machine start");

// The dialog answered: the turn goes on, nothing waiting below it.
const ANSWERED = ["⏺ Bash(podman machine list)", "  ⎿  NAME  VM TYPE", "", "⏺ The machine is up.", "", "────────", "❯ ", "────────"].join(
  "\n",
);

const MINUTE = 60_000;

function withState(body) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-escalation-"));
    const previous = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    try {
      await body(dir);
    } finally {
      if (previous === undefined) {
        delete process.env.HERDR_PLUGIN_STATE_DIR;
      } else {
        process.env.HERDR_PLUGIN_STATE_DIR = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// The poller's view of the world, all of it fake: what each pane shows, which
// panes exist, what was pinged and what was logged.
function world({ screens, closed = [], mainKind = "claude", status = "blocked" }) {
  const pinged = [];
  const panels = [];
  const lines = [];
  const run = (args) => {
    if (args[0] === "pane" && args[1] === "get") {
      return closed.includes(args[2])
        ? { status: 1, stdout: "", stderr: '{"error":{"code":"pane_not_found","message":"pane not found"}}' }
        : { status: 0, stdout: JSON.stringify({ result: { pane: { agent_status: typeof status === "function" ? status() : status } } }) };
    }
    if (args[0] === "agent" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify({ result: { agents: [{ name: "drover", agent: mainKind, pane_id: "w1:p1", agent_status: "idle" }] } }),
      };
    }
    return { status: 0, stdout: "" };
  };
  const pass = (now, extra = {}) =>
    checkEscalations({
      now,
      run,
      readScreen: (paneId) => screens[paneId] ?? "",
      settings: DROVER,
      enabled: true,
      channels: ["feishu"],
      panelReady: false,
      ping: async (call) => pinged.push(call),
      panel: (call) => panels.push(call),
      body: () => "podman machine list",
      wait: async () => {},
      log: (line) => lines.push(line),
      ...extra,
    });
  return { pinged, panels, lines, pass };
}

function arm(paneId, role, name, screen, now) {
  return armEscalation(
    { paneId, role, name, kind: "claude", where: `repo · ${name}`, fingerprint: dialogFingerprint(screen), thresholdSec: 600 },
    now,
  );
}

test(
  "the same dialog waiting past the threshold is pinged once, and only once",
  withState(async () => {
    const t0 = 1_000_000;
    arm("w7M:p1", "worker", "hca-e2e", DIALOG, t0);
    const w = world({ screens: { "w7M:p1": DIALOG } });

    assert.deepEqual(await w.pass(t0 + 9 * MINUTE), [{ paneId: "w7M:p1", outcome: "waiting" }]);
    assert.equal(w.pinged.length, 0);

    assert.deepEqual(await w.pass(t0 + 10 * MINUTE), [{ paneId: "w7M:p1", outcome: "pinged" }]);
    assert.equal(w.pinged.length, 1);
    const [ping] = w.pinged;
    assert.match(ping.text, /^升级 · worker hca-e2e 卡在确认框 10 分钟\nrepo · hca-e2e\n这类弹框平时由编排者批/);
    // Its buttons and fingerprint go out with it, as any blocked ping's do.
    assert.deepEqual(
      ping.options.map((option) => option.send),
      ["1", "2", "3"],
    );
    assert.equal(ping.fingerprint, dialogFingerprint(DIALOG));
    assert.ok(w.lines.includes("escalated · worker · hca-e2e · repo · hca-e2e · after 10 分钟"));

    assert.deepEqual(await w.pass(t0 + 11 * MINUTE), [{ paneId: "w7M:p1", outcome: "already" }]);
    assert.deepEqual(await w.pass(t0 + 60 * MINUTE), [{ paneId: "w7M:p1", outcome: "already" }]);
    assert.equal(w.pinged.length, 1);
  }),
);

test(
  "a Herdr event for the same dialog keeps its clock, a different dialog starts over",
  withState(async () => {
    const t0 = 2_000_000;
    assert.equal(arm("w7M:p1", "worker", "hca-e2e", DIALOG, t0).kept, false);
    const again = arm("w7M:p1", "worker", "hca-e2e", DIALOG, t0 + 4 * MINUTE);
    assert.equal(again.kept, true);
    assert.equal(again.record.startedAt, t0);

    // The poller sees the next dialog before any hook does: counted from now.
    const w = world({ screens: { "w7M:p1": NEXT_DIALOG } });
    assert.deepEqual(await w.pass(t0 + 9 * MINUTE), [{ paneId: "w7M:p1", outcome: "reset" }]);
    assert.equal(readEscalations()["w7M:p1"].startedAt, t0 + 9 * MINUTE);
    assert.equal(readEscalations()["w7M:p1"].fingerprint, dialogFingerprint(NEXT_DIALOG));
    assert.deepEqual(await w.pass(t0 + 12 * MINUTE), [{ paneId: "w7M:p1", outcome: "waiting" }]);
    assert.deepEqual(await w.pass(t0 + 19 * MINUTE), [{ paneId: "w7M:p1", outcome: "pinged" }]);

    // A hook arming a different dialog resets an escalated record too.
    const fresh = arm("w7M:p1", "worker", "hca-e2e", DIALOG, t0 + 20 * MINUTE);
    assert.equal(fresh.kept, false);
    assert.equal(fresh.record.escalatedAt, undefined);
  }),
);

test(
  "a dialog that left the screen is forgotten, a blank read is not evidence",
  withState(async () => {
    const t0 = 3_000_000;
    arm("w7M:p1", "worker", "hca-e2e", DIALOG, t0);
    arm("w7N:p1", "worker", "hca-sbx", DIALOG, t0);
    arm("w7P:p1", "worker", "hca-aux", DIALOG, t0);
    const w = world({ screens: { "w7M:p1": ANSWERED, "w7N:p1": "   " }, closed: ["w7P:p1"] });

    const outcomes = await w.pass(t0 + MINUTE);
    assert.deepEqual(outcomes, [
      { paneId: "w7M:p1", outcome: "cleared" },
      { paneId: "w7N:p1", outcome: "unreadable" },
      { paneId: "w7P:p1", outcome: "cleared" },
    ]);
    assert.deepEqual(Object.keys(readEscalations()), ["w7N:p1"]);
    assert.ok(w.lines.includes("escalation cleared · worker · hca-e2e · repo · hca-e2e · dialog gone"));
    assert.ok(w.lines.includes("escalation cleared · worker · hca-aux · repo · hca-aux · pane closed"));
  }),
);

test(
  "one read without the dialog is read again before the record goes",
  withState(async () => {
    const t0 = 4_000_000;
    arm("w7M:p1", "worker", "hca-e2e", DIALOG, t0);
    let reads = 0;
    const w = world({ screens: {} });
    // Mid-redraw on the first read, the dialog back on the second.
    const outcome = await w.pass(t0 + MINUTE, { readScreen: () => (reads++ === 0 ? ANSWERED : DIALOG) });
    assert.deepEqual(outcome, [{ paneId: "w7M:p1", outcome: "waiting" }]);
    assert.equal(readEscalations()["w7M:p1"].startedAt, t0);
  }),
);

test(
  "an orchestrator waits 5 minutes under Claude Code and 2 under Codex",
  withState(async () => {
    const t0 = 5_000_000;
    arm("w75:p7", "supervisor", "orch-oncall", DIALOG, t0);
    const claudeMain = world({ screens: { "w75:p7": DIALOG }, mainKind: "claude" });
    assert.deepEqual(await claudeMain.pass(t0 + 3 * MINUTE), [{ paneId: "w75:p7", outcome: "waiting" }]);

    const codexMain = world({ screens: { "w75:p7": DIALOG }, mainKind: "codex" });
    assert.deepEqual(await codexMain.pass(t0 + 3 * MINUTE), [{ paneId: "w75:p7", outcome: "pinged" }]);
    assert.match(codexMain.pinged[0].text, /^升级 · 编排者 orch-oncall 卡在确认框 3 分钟\n.*\n这类弹框平时由主会话批/);
  }),
);

test(
  "no phone paired: the desktop panel; neither: a line saying so; switched off: held",
  withState(async () => {
    const t0 = 6_000_000;
    arm("w7M:p1", "worker", "hca-e2e", DIALOG, t0);
    const panelOnly = world({ screens: { "w7M:p1": DIALOG } });
    assert.deepEqual(await panelOnly.pass(t0 + 10 * MINUTE, { channels: [], panelReady: true }), [
      { paneId: "w7M:p1", outcome: "panel" },
    ]);
    assert.equal(panelOnly.panels.length, 1);
    assert.equal(panelOnly.pinged.length, 0);

    arm("w7N:p1", "worker", "hca-sbx", DIALOG, t0);
    const nothing = world({ screens: { "w7M:p1": DIALOG, "w7N:p1": DIALOG } });
    const outcomes = await nothing.pass(t0 + 10 * MINUTE, { channels: [], panelReady: false });
    assert.deepEqual(outcomes.at(-1), { paneId: "w7N:p1", outcome: "unsent" });

    arm("w7P:p1", "worker", "hca-aux", DIALOG, t0);
    const off = world({ screens: { "w7M:p1": DIALOG, "w7N:p1": DIALOG, "w7P:p1": DIALOG } });
    assert.deepEqual((await off.pass(t0 + 10 * MINUTE, { enabled: false })).at(-1), { paneId: "w7P:p1", outcome: "held" });
    assert.equal(off.pinged.length, 0);
    // Turned back on, the dialog that is still waiting goes out.
    assert.deepEqual((await off.pass(t0 + 11 * MINUTE)).at(-1), { paneId: "w7P:p1", outcome: "pinged" });
  }),
);

// Seen live: a worker reading a session record printed an approval's text, and
// with only its spinner and the prompt box below, the screen read as a live
// dialog. The poller reset the worker's clock twice ("a different dialog is
// up") while Herdr said, rightly, that the worker was working.
const QUOTED = [
  "⏺ 会话记录里有一个确认框：",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "✶ Reading… (12s · esc to interrupt)",
  "",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

test(
  "dialog text the agent printed itself is not a dialog while Herdr says it is working",
  withState(async () => {
    // The premise: the screen alone cannot tell.
    assert.equal(screenHasLiveDialog(QUOTED), true);
    const t0 = 7_000_000;
    arm("w7T:p1", "worker", "ho-roles", DIALOG, t0);
    arm("w7W:p1", "worker", "dr-oncall", QUOTED, t0);
    const working = world({ screens: { "w7T:p1": QUOTED, "w7W:p1": QUOTED }, status: "working" });
    // Neither reset nor counted: the approved dialog's record is cleared, and
    // so is one armed on that very screen, ten minutes on or not.
    assert.deepEqual(await working.pass(t0 + 11 * MINUTE), [
      { paneId: "w7T:p1", outcome: "cleared" },
      { paneId: "w7W:p1", outcome: "cleared" },
    ]);
    assert.equal(working.pinged.length, 0);
    assert.deepEqual(readEscalations(), {});
    assert.ok(!working.lines.some((line) => line.startsWith("escalation reset")));
  }),
);

test(
  "the same screen with Herdr saying blocked, done or nothing still counts as the dialog",
  withState(async () => {
    const t0 = 8_000_000;
    arm("w7W:p1", "worker", "dr-oncall", QUOTED, t0);
    assert.deepEqual(await world({ screens: { "w7W:p1": QUOTED }, status: "blocked" }).pass(t0 + 5 * MINUTE), [
      { paneId: "w7W:p1", outcome: "waiting" },
    ]);
    // done / idle with a dialog drawn is Herdr missing it.
    assert.deepEqual(await world({ screens: { "w7W:p1": QUOTED }, status: "done" }).pass(t0 + 6 * MINUTE), [
      { paneId: "w7W:p1", outcome: "waiting" },
    ]);
    const unknown = world({ screens: { "w7W:p1": QUOTED }, status: undefined });
    assert.deepEqual(await unknown.pass(t0 + 10 * MINUTE), [{ paneId: "w7W:p1", outcome: "pinged" }]);
    assert.equal(readEscalations()["w7W:p1"].startedAt, t0);
  }),
);
