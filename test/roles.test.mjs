import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  API_ERROR_NOTICE,
  apiErrorLine,
  apiErrorMessage,
  classifyRole,
  escalateAfterSec,
  escalationText,
  lookupAgentByName,
  notifyPlan,
  paneAgentInfo,
  paneRole,
  roleSettings,
  rolesActive,
  stuckFor,
} from "../src/lib/index.mjs";

// What drover.env holds (contract section 3), as the environment loadDotEnv
// leaves behind.
const DROVER = {
  MAIN_AGENT_NAME: "drover",
  SUPERVISOR_PREFIX: "orch-",
  SUPERVISOR_ESCALATE_SEC: "300",
  SUPERVISOR_ESCALATE_SEC_CODEX: "120",
  SUPERVISED_ESCALATE_SEC: "600",
  BARE_MESSAGE_TARGET: "main",
};

// `herdr agent get` and `agent list` as herdr 0.9.5 prints them (trimmed): the
// user's own main session has no `name` key at all until drover registers it.
function agentGet(entry) {
  return JSON.stringify({ id: "cli:agent:get", result: { agent: entry, type: "agent_info" } });
}

function agentList(entries) {
  return JSON.stringify({ id: "cli:agent:list", result: { agents: entries, type: "agent_list" } });
}

const ENTRIES = [
  { agent: "claude", agent_status: "working", pane_id: "w1Z:p1", workspace_id: "w1Z" },
  { agent: "claude", agent_status: "done", name: "orch-voice-tool", pane_id: "w75:p4" },
  { agent: "claude", agent_status: "working", name: "hca-e2e", pane_id: "w7M:p1" },
];

function fakeRun({ get = {}, list = ENTRIES, calls = [] } = {}) {
  return (args) => {
    calls.push(args.join(" "));
    if (args[0] === "agent" && args[1] === "get") {
      const entry = get[args[2]];
      return entry ? { status: 0, stdout: agentGet(entry) } : { status: 1, stdout: "", stderr: "agent_not_found" };
    }
    if (args[0] === "agent" && args[1] === "list") {
      return list ? { status: 0, stdout: agentList(list) } : { status: 1, stdout: "", stderr: "server not running" };
    }
    return { status: 1, stdout: "" };
  };
}

test("the drover keys are documented in .env.example but never set there", () => {
  // .env.example is what a user's .env is seeded from. A live line there
  // would be copied into it and, with a value, beat drover.env forever.
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const live = example
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("=")[0]);
  for (const key of Object.keys(DROVER)) {
    assert.ok(!live.includes(key), `${key} is a live line in .env.example`);
    assert.match(example, new RegExp(`#\\s+${key}=`));
  }
});

test("the four rows of the role table, by Herdr agent name", () => {
  const settings = roleSettings(DROVER);
  assert.equal(classifyRole("drover", settings), "main");
  assert.equal(classifyRole("orch-oncall", settings), "supervisor");
  assert.equal(classifyRole("hca-e2e", settings), "worker");
  // A review pane is a worker like any other named agent.
  assert.equal(classifyRole("hca-e2e-rev", settings), "worker");
  assert.equal(classifyRole(undefined, settings), "user");
  assert.equal(classifyRole("", settings), "user");
});

test("with MAIN_AGENT_NAME empty every pane is the user's, whatever its name", () => {
  for (const env of [{}, { MAIN_AGENT_NAME: "" }, { MAIN_AGENT_NAME: "   ", SUPERVISOR_PREFIX: "orch-" }]) {
    const settings = roleSettings(env);
    assert.equal(rolesActive(settings), false);
    for (const name of ["drover", "orch-oncall", "hca-e2e", undefined]) {
      assert.equal(classifyRole(name, settings), "user");
    }
  }
});

test("the settings fall back to the contract's defaults, and an empty value is unset", () => {
  assert.deepEqual(roleSettings({}), {
    mainAgentName: "",
    supervisorPrefix: "orch-",
    supervisorEscalateSec: 300,
    supervisorEscalateSecCodex: 120,
    supervisedEscalateSec: 600,
    bareMessageTarget: "last",
  });
  const odd = roleSettings({
    MAIN_AGENT_NAME: "drover",
    SUPERVISOR_PREFIX: "",
    SUPERVISED_ESCALATE_SEC: "ten minutes",
    SUPERVISOR_ESCALATE_SEC: "60",
    BARE_MESSAGE_TARGET: "MAIN",
  });
  assert.equal(odd.supervisorPrefix, "orch-");
  assert.equal(odd.supervisedEscalateSec, 600);
  assert.equal(odd.supervisorEscalateSec, 60);
  assert.equal(odd.bareMessageTarget, "main");
  assert.equal(roleSettings({ BARE_MESSAGE_TARGET: "somewhere" }).bareMessageTarget, "last");
});

// proposal 3.3, one row per assertion.
test("notifyPlan follows the notification table row by row", () => {
  // main session: dialogs and every done as before; an API error says so
  assert.equal(notifyPlan({ role: "main", status: "blocked" }), "default");
  assert.equal(notifyPlan({ role: "main", status: "done" }), "default");
  assert.equal(notifyPlan({ role: "main", status: "done", apiError: true }), "api-error");
  // orchestrator
  assert.equal(notifyPlan({ role: "supervisor", status: "done" }), "quiet");
  assert.equal(notifyPlan({ role: "supervisor", status: "finish" }), "quiet");
  assert.equal(notifyPlan({ role: "supervisor", status: "blocked" }), "escalate");
  // worker
  assert.equal(notifyPlan({ role: "worker", status: "done" }), "quiet");
  assert.equal(notifyPlan({ role: "worker", status: "blocked" }), "escalate");
  // a pane with no name, and every pane without drover
  assert.equal(notifyPlan({ role: "user", status: "blocked" }), "default");
  assert.equal(notifyPlan({ role: "user", status: "done" }), "default");
  // an API error only changes the main session's ping
  assert.equal(notifyPlan({ role: "user", status: "done", apiError: true }), "default");
});

test("paneRole asks Herdr nothing while MAIN_AGENT_NAME is empty", () => {
  const calls = [];
  const run = fakeRun({ get: { "w7M:p1": ENTRIES[2] }, calls });
  assert.deepEqual(paneRole("w7M:p1", { settings: roleSettings({}), run }), { role: "user", agent: undefined });
  assert.deepEqual(calls, []);

  const active = paneRole("w7M:p1", { settings: roleSettings(DROVER), run });
  assert.equal(active.role, "worker");
  assert.equal(active.agent.name, "hca-e2e");
  assert.deepEqual(calls, ["agent get w7M:p1"]);
});

test("an agent's name is its `name`, not its kind, and a pane without one has none", () => {
  const run = fakeRun({ get: { "w1Z:p1": ENTRIES[0], "w75:p4": ENTRIES[1] } });
  assert.deepEqual(paneAgentInfo("w1Z:p1", run), { name: undefined, kind: "claude", status: "working", paneId: "w1Z:p1" });
  assert.equal(paneAgentInfo("w75:p4", run).name, "orch-voice-tool");
  // `agent get` failing falls back to the list.
  assert.equal(paneAgentInfo("w7M:p1", run).name, "hca-e2e");
  assert.equal(paneAgentInfo("w9:p9", run), undefined);
});

test("the main session is found by name in the list, every time", () => {
  const unregistered = fakeRun();
  assert.deepEqual(lookupAgentByName("drover", unregistered), { found: false });
  const registered = fakeRun({
    list: [...ENTRIES.slice(1), { ...ENTRIES[0], name: "drover", agent: "codex", agent_status: "idle" }],
  });
  assert.deepEqual(lookupAgentByName("drover", registered), {
    found: true,
    name: "drover",
    kind: "codex",
    status: "idle",
    paneId: "w1Z:p1",
  });
  const down = lookupAgentByName("drover", fakeRun({ list: null }));
  assert.equal(down.found, false);
  assert.match(down.error, /server not running/);
});

test("an orchestrator under a Codex main session escalates sooner", () => {
  const settings = roleSettings(DROVER);
  assert.equal(escalateAfterSec({ role: "supervisor", mainKind: "claude", settings }), 300);
  assert.equal(escalateAfterSec({ role: "supervisor", mainKind: undefined, settings }), 300);
  assert.equal(escalateAfterSec({ role: "supervisor", mainKind: "codex", settings }), 120);
  assert.equal(escalateAfterSec({ role: "worker", mainKind: "codex", settings }), 600);
});

test("an escalation says who, for how long, where, and who normally answers", () => {
  const text = escalationText({
    role: "worker",
    name: "hca-e2e",
    elapsedMs: 10 * 60_000 + 25_000,
    where: "his-claw-agent · task-private-model-eval-e2e",
    body: "Do you want to proceed?  podman machine list",
  });
  assert.deepEqual(text.split("\n"), [
    "升级 · worker hca-e2e 卡在确认框 10 分钟",
    "his-claw-agent · task-private-model-eval-e2e",
    "这类弹框平时由编排者批，它可能在忙或卡住了",
    "",
    "Do you want to proceed?  podman machine list",
    "",
    "tap a button, or type another answer",
  ]);
  const orch = escalationText({ role: "supervisor", name: "orch-x", elapsedMs: 5 * 60_000, where: "Git-Repo", body: "" });
  assert.match(orch, /^升级 · 编排者 orch-x 卡在确认框 5 分钟\nGit-Repo\n这类弹框平时由主会话批/);
  assert.equal(stuckFor(45_000), "45 秒");
  // Plain text, like every other message: no emoji anywhere.
  assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
});

test("an API error counts only as the last output block, at the start of a line", () => {
  const claude = ["⏺ Reading the logs", "", "⏺ API Error: 503 No available accounts", "", "────", "❯ ", "────", "  ⏵⏵ auto mode on"].join("\n");
  assert.equal(apiErrorLine(claude), "⏺ API Error: 503 No available accounts");
  const underTool = ["⏺ Bash(ls)", "  ⎿  API Error: 529 overloaded", "", "────", "❯ "].join("\n");
  assert.equal(apiErrorLine(underTool), "⎿  API Error: 529 overloaded");
  const codex = ["• Working on it", "", "■ stream disconnected before completion", "", "› Ask Codex to do anything"].join("\n");
  assert.equal(apiErrorLine(codex), "■ stream disconnected before completion");
  assert.equal(apiErrorLine("■ Unexpected status 502 Bad Gateway"), "■ Unexpected status 502 Bad Gateway");
  // A report that talks about API errors, and an error followed by more output.
  assert.equal(apiErrorLine("⏺ The worker said API_ERROR_RE misses API Error lines.\n\n❯ "), undefined);
  assert.equal(apiErrorLine("⏺ API Error: 503\n\n⏺ Retried, all good now.\n❯ "), undefined);
  assert.equal(apiErrorLine("  so I wrote: API Error handling is fine"), undefined);
  assert.equal(
    apiErrorMessage("⏺ API Error: 503 No available accounts"),
    `${API_ERROR_NOTICE}\n\n⏺ API Error: 503 No available accounts`,
  );
});
