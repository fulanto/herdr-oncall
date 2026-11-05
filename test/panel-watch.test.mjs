import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isTerminalBundle,
  panelFocus,
  panelOutranks,
  panelStderr,
  showPanel,
  userAtPane,
} from "../src/lib/index.mjs";

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

// A panel that writes the arguments it was started with to `argsFile`, one
// NUL-terminated entry each, and times out at once.
function recordingPanel(dir, argsFile) {
  const path = join(dir, "oncall-panel-recording");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsFile}'\necho timeout\n`);
  chmodSync(path, 0o755);
  return path;
}

function recordedArgs(argsFile) {
  return readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
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

test("our own panel in front is not the user arriving at the pane", () => {
  // The panel is a bare binary with no CFBundleIdentifier, and it activates
  // itself so an input method will attach. Reading that as "cannot identify the
  // frontmost app" made the fallback fire and the panel closed itself two
  // seconds after opening, while the user was still reaching for it.
  assert.equal(
    userAtPane("w1:p1", { focused: () => true, frontmost: () => ({ name: "oncall-panel" }) }),
    false,
  );
  // Some other unbundled app really is unidentifiable; that fallback stands.
  assert.equal(
    userAtPane("w1:p1", { focused: () => true, frontmost: () => ({ name: "Some Helper" }) }),
    true,
  );
  assert.equal(
    userAtPane("w1:p1", {
      focused: () => true,
      frontmost: () => ({ bundleId: "com.termius-dmg.mac", name: "Termius" }),
    }),
    true,
  );
  assert.equal(
    userAtPane("w1:p1", {
      focused: () => true,
      frontmost: () => ({ bundleId: "com.apple.Safari", name: "Safari" }),
    }),
    false,
  );
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

test("a hook's panel never grabs the keyboard as it appears", () => {
  // Both open whenever the agent gets there, mostly while the user is typing in
  // another app, and a panel that took the caret caught the rest of their
  // sentence. A done panel only reports; a question waits for a click, the
  // next question of a form included.
  assert.equal(panelFocus({ status: "done" }), "never");
  assert.equal(panelFocus({ status: "blocked" }), "click");
});

test("only done is passive, and nothing asks the panel to take the keyboard", { skip: process.platform === "win32" }, async () => {
  // Clicking to focus is the binary's only way to take the keyboard, so every
  // panel that is not passive goes out with no switch at all.
  await withPanelState(async (dir) => {
    const argsFile = join(dir, "args");
    const binary = recordingPanel(dir, argsFile);
    const common = { where: "repo · task · pane 1", body: "the last turn", timeoutMs: 4_000, binary };

    const report = await showPanel({
      ...common,
      paneId: "wP:p1",
      title: "done · Test",
      kind: "report",
      focus: panelFocus({ status: "done" }),
    });
    assert.deepEqual(report, { kind: "timeout" });
    const doneArgs = recordedArgs(argsFile);
    assert.equal(doneArgs[0], "--passive", "the switch comes before the positional arguments");
    assert.deepEqual(doneArgs.slice(1), ["4", "done · Test", "repo · task · pane 1", "the last turn"]);

    const blocked = { ...common, title: "blocked · Test", kind: "blocked", options: [{ key: "1", label: "Yes" }] };
    const positional = ["4", "blocked · Test", "repo · task · pane 1", "the last turn", "1. Yes"];
    await showPanel({ ...blocked, paneId: "wP:p2", focus: panelFocus({ status: "blocked" }) });
    assert.deepEqual(recordedArgs(argsFile), positional, "a question: buttons and everything else as before");

    // No value of `focus` makes a panel take the keyboard as it opens.
    await showPanel({ ...blocked, paneId: "wP:p3", focus: "take" });
    assert.deepEqual(recordedArgs(argsFile), positional);
  });
});

test("the test and pairing panels click to focus like the rest", { skip: process.platform === "win32" }, async () => {
  // They pass no focus and get the default; the QR panel keeps its --qr.
  await withPanelState(async (dir) => {
    const argsFile = join(dir, "args");
    const binary = recordingPanel(dir, argsFile);

    // The same call src/actions/test.mjs makes.
    await showPanel({
      title: "test · no pane",
      where: "Oncall test panel",
      body: "If you can see this, the desktop panel works.\nNothing pressed here reaches a pane.",
      options: [{ key: "1", label: "Looks good" }],
      timeoutMs: 4_000,
      binary,
    });
    assert.deepEqual(recordedArgs(argsFile), [
      "4",
      "test · no pane",
      "Oncall test panel",
      "If you can see this, the desktop panel works.\nNothing pressed here reaches a pane.",
      "1. Looks good",
    ]);

    // The pairing QR panel, as src/actions/pair-feishu.mjs opens it.
    await showPanel({
      title: "scan with the Feishu app",
      where: "Pair Feishu",
      body: "caption",
      qr: "https://example.invalid/scan",
      timeoutMs: 4_000,
      until: () => undefined,
      binary,
    });
    assert.deepEqual(recordedArgs(argsFile), [
      "--qr",
      "https://example.invalid/scan",
      "4",
      "scan with the Feishu app",
      "Pair Feishu",
      "caption",
    ]);

    // A report panel without a focus gets the default too: `kind` only decides
    // who gives way to whom in panels.json.
    await showPanel({ title: "t", where: "w", body: "b", timeoutMs: 4_000, binary, paneId: "wK:p1", kind: "report" });
    assert.deepEqual(recordedArgs(argsFile), ["4", "t", "w", "b"]);
  });
});
