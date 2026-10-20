import assert from "node:assert/strict";
import test from "node:test";
import { integrationLines, setupHints } from "../src/lib/index.mjs";

const envPath = "/cfg/.env";
// A current Node unless a test says otherwise, so the hints do not depend on
// whichever Node runs the suite.
const fresh = { envPath, websocket: true, nodeVersion: "v24.1.0" };

function index(lines, pattern) {
  return lines.findIndex((line) => pattern.test(line));
}

test("a new Mac install is told the panel already works and a phone channel is optional", () => {
  const lines = setupHints({ ...fresh, panel: "ready" });
  assert.match(lines[0], /^panel: ready/);
  assert.ok(lines.some((line) => /^remote \(optional/.test(line)));
  assert.ok(lines.some((line) => line.includes("action invoke test")));
  assert.ok(!lines.some((line) => line.includes("TELEGRAM_CHAT_ID")));
});

test("Feishu is offered first, as the one that needs no token", () => {
  const lines = setupHints({ ...fresh, panel: "ready" });
  const feishu = index(lines, /^ {2}feishu: scan with the Feishu app, no token needed/);
  const telegram = index(lines, /^ {2}telegram: put TELEGRAM_BOT_TOKEN in \/cfg\/\.env/);
  assert.ok(feishu > 0 && telegram > feishu, lines.join("\n"));
  assert.ok(lines[feishu + 1].endsWith("action invoke pair-feishu --plugin com.codreamer.herdr.oncall"));
  assert.ok(lines[telegram + 1].endsWith("action invoke pair --plugin com.codreamer.herdr.oncall"));
});

test("the hint says where the QR code will be", () => {
  const mac = setupHints({ ...fresh, panel: "ready" });
  assert.ok(mac.includes("    (the QR opens in a panel on this Mac)"));
  for (const panel of ["unsupported", "unbuilt", "off"]) {
    const lines = setupHints({ ...fresh, panel });
    assert.ok(lines.some((line) => line.includes("(the QR is in: herdr plugin log list")), panel);
  }
});

test("a Node too old for Feishu replies is named before anyone scans", () => {
  const old = setupHints({ ...fresh, panel: "ready", websocket: false, nodeVersion: "v20.11.0" });
  assert.ok(old.includes("    (replies need Node 22 or later, this is v20.11.0)"));
  assert.ok(!setupHints({ ...fresh, panel: "ready" }).some((line) => line.includes("Node 22")));
  const paired = setupHints({ ...fresh, panel: "ready", feishu: true, channels: ["feishu"], websocket: false, nodeVersion: "v20.11.0" });
  assert.ok(paired.includes("feishu: paired, but replies need Node 22 or later, this is v20.11.0"));
});

test("with no panel, a phone channel is needed and there is nothing to test yet", () => {
  for (const panel of ["unsupported", "unbuilt", "off"]) {
    const lines = setupHints({ ...fresh, panel });
    assert.ok(lines.some((line) => /^remote \(needed/.test(line)), panel);
    assert.ok(!lines.some((line) => line.includes("action invoke test")), panel);
  }
  assert.ok(!setupHints({ ...fresh, panel: "unsupported" }).some((line) => line.startsWith("panel:")));
  assert.ok(setupHints({ ...fresh, panel: "unbuilt" }).some((line) => line.includes("xcode-select --install")));
});

test("a token without a chat is pointed at pairing, and a paired chat at nothing", () => {
  const unpaired = setupHints({ ...fresh, panel: "ready", token: "t" });
  assert.ok(unpaired.some((line) => line.trim().startsWith("telegram: token set")));
  assert.ok(unpaired.some((line) => line.endsWith("action invoke pair --plugin com.codreamer.herdr.oncall")));

  const paired = setupHints({ ...fresh, panel: "unsupported", token: "t", chatId: "1" });
  assert.ok(paired.includes("telegram: paired"));
  assert.ok(!paired.some((line) => line.includes("action invoke pair")));
  assert.ok(paired.some((line) => line.includes("action invoke test")));
});

test("a paired Feishu leaves Telegram's setup out", () => {
  const lines = setupHints({ ...fresh, panel: "unsupported", feishu: true, channels: ["feishu"] });
  assert.ok(lines.includes("feishu: paired"));
  assert.ok(!lines.some((line) => line.trim().startsWith("telegram:")));
  assert.ok(!lines.some((line) => line.includes("action invoke pair")));
  assert.ok(lines.some((line) => line.includes("action invoke test")));
});

test("a paired channel that CHANNEL leaves out says so", () => {
  const lines = setupHints({ ...fresh, panel: "ready", token: "t", chatId: "1", feishu: true, channels: ["feishu"] });
  assert.ok(lines.includes("feishu: paired"));
  assert.ok(lines.includes("telegram: paired, but CHANNEL does not include it"));
});

test("an agent still without Herdr's integration is pointed at installing it", () => {
  const lines = setupHints({ ...fresh, panel: "ready", feishu: true, channels: ["feishu"], integrations: ["codex"] });
  const head = index(lines, /^done pings: these agents need Herdr's integration/);
  assert.ok(head >= 0, lines.join("\n"));
  assert.equal(lines[head + 1], "  herdr integration install codex");
  assert.ok(!setupHints({ ...fresh, panel: "ready" }).some((line) => line.includes("herdr integration")));
});

test("what the automatic install did is said once, failures included", () => {
  assert.deepEqual(integrationLines({ installed: [], failed: [] }), []);
  const [installed, failed] = integrationLines({
    installed: ["codex"],
    failed: [{ agent: "codex", detail: "no config dir" }],
  });
  assert.match(installed, /^codex: installed Herdr's codex integration.*restart codex sessions already running/);
  assert.equal(failed, "codex: herdr integration install codex failed: no config dir");
});
