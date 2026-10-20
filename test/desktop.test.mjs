import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { panelLabels, panelState, panelTimeoutMs, parsePanelResult } from "../src/lib/index.mjs";

test("parsePanelResult reads the last stdout line", () => {
  assert.deepEqual(parsePanelResult("button:2\n"), { kind: "button", index: 2 });
  assert.deepEqual(parsePanelResult("text: don't delete that \n"), { kind: "text", text: "don't delete that" });
  assert.deepEqual(parsePanelResult("timeout\n"), { kind: "timeout" });
  assert.deepEqual(parsePanelResult("dismiss"), { kind: "dismiss" });
  assert.deepEqual(parsePanelResult(""), { kind: "timeout" });
  assert.deepEqual(parsePanelResult("text:\n"), { kind: "timeout" });
  assert.deepEqual(parsePanelResult("noise\nbutton:0"), { kind: "button", index: 0 });
});

test("panelTimeoutMs prefers its own setting, then the blocked delay", () => {
  const previousDelay = process.env.BLOCKED_DELAY_SEC;
  try {
    delete process.env.BLOCKED_DELAY_SEC;
    assert.equal(panelTimeoutMs("15"), 15_000);
    assert.equal(panelTimeoutMs(""), 60_000);
    process.env.BLOCKED_DELAY_SEC = "45";
    assert.equal(panelTimeoutMs(undefined), 45_000);
    process.env.BLOCKED_DELAY_SEC = "0";
    assert.equal(panelTimeoutMs(undefined), 60_000);
  } finally {
    if (previousDelay === undefined) {
      delete process.env.BLOCKED_DELAY_SEC;
    } else {
      process.env.BLOCKED_DELAY_SEC = previousDelay;
    }
  }
});

test("panelLabels numbers options like the Telegram keyboard", () => {
  const labels = panelLabels([
    { key: "1", send: "y", label: "Yes, proceed" },
    { key: "3", send: "esc", label: "No, and tell Codex what to do differently" },
  ]);
  assert.deepEqual(labels, ["1. Yes, proceed", "3. No, and tell Codex what to do differently"]);
});

test("panelState says why the panel cannot open", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-panel-state-"));
  const binary = join(dir, "oncall-panel");
  const previous = process.env.DESKTOP_PANEL;
  try {
    delete process.env.DESKTOP_PANEL;
    assert.equal(panelState({ platform: "darwin", binary }), "unbuilt");
    assert.equal(panelState({ platform: "darwin", binary: dir }), "unbuilt");
    writeFileSync(binary, "");
    assert.equal(panelState({ platform: "darwin", binary }), "ready");
    assert.equal(panelState({ platform: "linux", binary }), "unsupported");
    process.env.DESKTOP_PANEL = "0";
    assert.equal(panelState({ platform: "darwin", binary }), "off");
  } finally {
    if (previous === undefined) {
      delete process.env.DESKTOP_PANEL;
    } else {
      process.env.DESKTOP_PANEL = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
