import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isTerminalBundle, showPanel, userAtPane } from "../src/lib/index.mjs";

// A stand-in for the compiled panel: waits until killed, prints nothing.
function fakePanel(dir) {
  const path = join(dir, "oncall-panel");
  writeFileSync(path, "#!/bin/sh\ntrap 'exit 0' TERM\nsleep 30 &\nwait $!\n");
  chmodSync(path, 0o755);
  return path;
}

test("showPanel closes the panel when until() reports a reason", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-panel-"));
  const previousState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    const binary = fakePanel(dir);
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
      binary,
    });
    assert.deepEqual(result, { kind: "resolved", reason: "at-pane" });
    assert.ok(Date.now() - started < 5000, "closed well before the timeout");
  } finally {
    if (previousState === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previousState;
    }
    rmSync(dir, { recursive: true, force: true });
  }
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
