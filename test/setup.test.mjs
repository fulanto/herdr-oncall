import assert from "node:assert/strict";
import test from "node:test";
import { setupHints } from "../src/lib/index.mjs";

const envPath = "/cfg/.env";

test("a new Mac install is told the panel already works and Telegram is optional", () => {
  const lines = setupHints({ panel: "ready", envPath });
  assert.match(lines[0], /^panel: ready/);
  assert.ok(lines.some((line) => /^telegram: optional/.test(line)));
  assert.ok(lines.some((line) => line.includes("action invoke test")));
  assert.ok(!lines.some((line) => line.includes("TELEGRAM_CHAT_ID")));
});

test("with no panel, Telegram is the channel and there is nothing to test yet", () => {
  for (const panel of ["unsupported", "unbuilt", "off"]) {
    const lines = setupHints({ panel, envPath });
    assert.ok(lines.some((line) => /^telegram: needed/.test(line)), panel);
    assert.ok(!lines.some((line) => line.includes("action invoke test")), panel);
  }
  assert.ok(!setupHints({ panel: "unsupported", envPath }).some((line) => line.startsWith("panel:")));
  assert.ok(setupHints({ panel: "unbuilt", envPath }).some((line) => line.includes("xcode-select --install")));
});

test("a token without a chat is pointed at pairing, and a paired chat at nothing", () => {
  const unpaired = setupHints({ panel: "ready", token: "t", envPath });
  assert.ok(unpaired.some((line) => line.startsWith("telegram: token set")));
  assert.ok(unpaired.some((line) => line.includes("action invoke pair")));

  const paired = setupHints({ panel: "unsupported", token: "t", chatId: "1", envPath });
  assert.ok(paired.includes("telegram: paired"));
  assert.ok(!paired.some((line) => line.includes("action invoke pair")));
  assert.ok(paired.some((line) => line.includes("action invoke test")));
});
