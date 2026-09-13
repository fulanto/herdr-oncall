import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isTerminalBundle, showPanel, userAtPane } from "../src/lib/index.mjs";

// A stand-in for the compiled panel: waits until killed, prints nothing, and
// takes its sleep with it so the test leaves nothing behind.
function fakePanel(dir) {
  const path = join(dir, "oncall-panel");
  writeFileSync(path, "#!/bin/sh\nsleep 30 &\np=$!\ntrap 'kill $p 2>/dev/null; exit 0' TERM\nwait $p\n");
  chmodSync(path, 0o755);
  return path;
}

// The opposite: a panel that exits on TERM but leaves a child holding the pipes
// it inherited. Node's `close` event waits for those pipes, so resolving on it
// would park the hook here for the guard timeout. CI caught this as a real
// failure when a `/bin/sh` other than this machine's orphaned the sleep.
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
