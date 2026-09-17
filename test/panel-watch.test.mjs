import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isTerminalBundle, panelOutranks, panelStderr, showPanel, userAtPane } from "../src/lib/index.mjs";

// A stand-in for the compiled panel: waits until killed, prints nothing, and
// takes its sleep with it so the test leaves nothing behind.
function fakePanel(dir) {
  const path = join(dir, "oncall-panel");
  writeFileSync(path, "#!/bin/sh\nsleep 30 &\np=$!\ntrap 'kill $p 2>/dev/null; exit 0' TERM\nwait $p\n");
  chmodSync(path, 0o755);
  return path;
}

// The opposite: a panel that quits the moment it starts, leaving a child that
// still holds the pipes it inherited. Node's `close` waits for those pipes, so
// resolving on it parks the hook until the stray child ends, and `exit` has
// already fired by the time the watcher decides — this exact script hung every
// CI runner for the guard timeout while this machine could not reproduce it.
function leakyPanel(dir) {
  const path = join(dir, "oncall-panel-leaky");
  writeFileSync(path, "#!/bin/sh\nsh -c 'sleep 30' &\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function withPanelState(body) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-panel-"));
  const previousState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  return Promise.resolve(body(dir)).finally(() => {
    if (previousState === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previousState;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

test("showPanel closes the panel when until() reports a reason", { skip: process.platform === "win32" }, async () => {
  await withPanelState(async (dir) => {
    const started = Date.now();
    let polls = 0;
    const result = await showPanel({
      paneId: "wT:p1",
      title: "blocked · Test",
      where: "test",
      body: "",
      options: [],
      timeoutMs: 10_000,
      until: () => (++polls >= 2 ? "at-pane" : false),
      watchMs: 50,
      binary: fakePanel(dir),
    });
    assert.deepEqual(result, { kind: "resolved", reason: "at-pane" });
    assert.ok(Date.now() - started < 5000, "closed well before the timeout");
  });
});

test("a panel that leaves a child behind does not hold the hook", { skip: process.platform === "win32" }, async () => {
  await withPanelState(async (dir) => {
    const started = Date.now();
    let polls = 0;
    const result = await showPanel({
      paneId: "wT:p2",
      title: "blocked · Test",
      where: "test",
      body: "",
      options: [],
      timeoutMs: 10_000,
      until: () => (++polls >= 2 ? "moved-on" : false),
      watchMs: 50,
      binary: leakyPanel(dir),
    });
    assert.deepEqual(result, { kind: "resolved", reason: "moved-on" });
    // The leaked `sleep 30` still owns the pipe; resolving on `close` would
    // have parked here for half a minute.
    assert.ok(Date.now() - started < 5000, "resolved on the panel's exit, not on its pipes");
  });
});

test("isTerminalBundle knows common terminals and honours extras", () => {
  assert.equal(isTerminalBundle("com.termius-dmg.mac"), true);
  assert.equal(isTerminalBundle("com.googlecode.iterm2"), true);
  assert.equal(isTerminalBundle("com.mitchellh.ghostty"), true);
  assert.equal(isTerminalBundle("com.apple.Safari"), false);
  assert.equal(isTerminalBundle("com.example.shell", "com.example.shell,com.other"), true);
  assert.equal(isTerminalBundle("", "com.example.shell"), false);
});

test("userAtPane needs the pane focused and a terminal in front", () => {
  assert.equal(userAtPane("w1:p1", { focused: () => true, frontmost: () => "com.termius-dmg.mac" }), true);
  assert.equal(userAtPane("w1:p1", { focused: () => true, frontmost: () => "com.apple.Safari" }), false);
  assert.equal(userAtPane("w1:p1", { focused: () => false, frontmost: () => "com.termius-dmg.mac" }), false);
  assert.equal(userAtPane("w1:p1", { focused: () => undefined, frontmost: () => "com.termius-dmg.mac" }), false);
  assert.equal(userAtPane("w1:p1", { focused: () => true, frontmost: () => undefined }), true);
});

test("input-method chatter is dropped, a real panel error is not", () => {
  // Verbatim from a panel run after it started activating its app so Chinese
  // input would reach the field.
  const chatter = [
    "2026-09-14 14:12:52.051 oncall-panel[34178:26722815] error messaging the mach port for IMKCFRunLoopWakeUpReliable",
    "2026-09-14 14:12:55.839 oncall-panel[34178:26722815] TSM AdjustCapsLockLEDForKeyTransitionHandling - _ISSetPhysicalKeyboardCapsLockLED Inhibit",
  ].join("\n");
  assert.equal(panelStderr(chatter), "");
  assert.equal(panelStderr(`${chatter}\ndyld: Library not loaded: AppKit`), "dyld: Library not loaded: AppKit");
  assert.equal(panelStderr(""), "");
  assert.equal(panelStderr(undefined), "");
});

test("a report never takes a question's place", () => {
  // Claude Code emits blocked and done for one pane inside a second. Keyed on
  // the pane alone, the done panel evicted the blocked one and the question the
  // user had to answer disappeared without even reaching Telegram.
  assert.equal(panelOutranks("blocked", "blocked"), true, "a newer question replaces a stale one");
  assert.equal(panelOutranks("blocked", "report"), false, "a report must stand down");
  assert.equal(panelOutranks("report", "blocked"), true, "a question takes a report's place");
  assert.equal(panelOutranks("report", "report"), true);
  assert.equal(panelOutranks(undefined, "report"), true, "nothing standing, go ahead");
  // A panel opened by an older build recorded no kind at all.
  assert.equal(panelOutranks(undefined, "blocked"), true);
});

test("a done panel yields to a live blocked panel instead of killing it", { skip: process.platform === "win32" }, async () => {
  await withPanelState(async (dir) => {
    const binary = fakePanel(dir);
    let polls = 0;
    // A question is up and waiting.
    const question = showPanel({
      paneId: "wY:p1",
      title: "blocked · Test",
      where: "test",
      body: "",
      options: [],
      timeoutMs: 10_000,
      until: () => (++polls >= 8 ? "moved-on" : false),
      watchMs: 50,
      binary,
      kind: "blocked",
    });
    await new Promise((done) => setTimeout(done, 120));

    const report = await showPanel({
      paneId: "wY:p1",
      title: "done · Test",
      where: "test",
      body: "the last turn",
      options: [],
      timeoutMs: 10_000,
      until: () => true,
      watchMs: 50,
      binary,
      kind: "report",
    });
    assert.deepEqual(report, { kind: "yielded" }, "the report stood down");

    // And the question is still the one standing, answered on its own terms.
    assert.deepEqual(await question, { kind: "resolved", reason: "moved-on" });
  });
});
