import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchWorktreeInfo,
  formatWhere,
  resolveWorktree,
  workspaceIdFrom,
  worktreeLabel,
  worktreeName,
  worktreeShortName,
} from "../src/lib/index.mjs";

const REPO_ROOT = "/Users/me/projects/sample/sample-portal";
const CHECKOUT = "/Users/me/.herdr/worktrees/sample-portal/build-deploy-plan";

// `herdr worktree list --workspace <id>` for a repo with one linked worktree.
const listed = JSON.stringify({
  result: {
    source: { repo_name: "sample-portal", repo_root: REPO_ROOT, source_workspace_id: "w8" },
    worktrees: [
      { branch: "main", is_linked_worktree: false, is_detached: false, open_workspace_id: "w8", path: REPO_ROOT },
      {
        branch: "build_deploy_plan",
        is_linked_worktree: true,
        is_detached: false,
        open_workspace_id: "wJ",
        path: CHECKOUT,
      },
    ],
  },
});

// A plain checkout on a feature branch: no `worktree` block anywhere, which is
// the shape that used to show nothing but the workspace label.
const plain = JSON.stringify({
  result: {
    source: { repo_name: "billing-worker", repo_root: "/Users/me/projects/billing-worker" },
    worktrees: [
      {
        branch: "develop5",
        is_linked_worktree: false,
        is_detached: false,
        open_workspace_id: "wG",
        path: "/Users/me/projects/billing-worker",
      },
    ],
  },
});

function fakeHerdr(args) {
  const key = args.join(" ");
  if (key === "worktree list --workspace wJ" || key === "worktree list --workspace w8") {
    return { status: 0, stdout: listed };
  }
  if (key === "worktree list --workspace wG") {
    return { status: 0, stdout: plain };
  }
  return { status: 1, stdout: "", stderr: `unexpected ${key}` };
}

test("worktreeName only names linked worktrees", () => {
  assert.equal(worktreeName({ checkout_path: CHECKOUT, is_linked_worktree: true }), "build-deploy-plan");
  assert.equal(worktreeName({ checkout_path: CHECKOUT, is_linked_worktree: false }), undefined);
  assert.equal(worktreeName(undefined), undefined);
});

test("worktreeLabel names the worktree, or the branch of a plain checkout", () => {
  const linked = { checkout_path: CHECKOUT, is_linked_worktree: true };
  assert.equal(worktreeLabel({ ...linked, branch: "build_deploy_plan" }), "build-deploy-plan");
  assert.equal(worktreeLabel({ ...linked, branch: "Build/Deploy/Plan" }), "build-deploy-plan");
  assert.equal(worktreeLabel(linked), "build-deploy-plan");
  assert.equal(worktreeLabel({ ...linked, branch: "feature/PROJ-1234" }), "build-deploy-plan (feature/PROJ-1234)");

  assert.equal(worktreeLabel({ is_linked_worktree: false, branch: "develop5" }), "develop5");
  // The default branch is a fact worth stating too.
  assert.equal(worktreeLabel({ is_linked_worktree: false, branch: "main" }), "main");
  assert.equal(worktreeLabel({ is_linked_worktree: false, branch: "master" }), "master");
  assert.equal(worktreeLabel({ is_linked_worktree: false }), undefined);
  assert.equal(worktreeLabel(undefined), undefined);
});

test("worktreeShortName is what the workspace label might repeat", () => {
  assert.equal(worktreeShortName({ checkout_path: CHECKOUT, is_linked_worktree: true }), "build-deploy-plan");
  assert.equal(worktreeShortName({ is_linked_worktree: false, branch: "develop5" }), "develop5");
  assert.equal(worktreeShortName(undefined), undefined);
});

test("workspaceIdFrom falls back to the pane id prefix", () => {
  assert.equal(workspaceIdFrom({ workspace_id: "wJ" }, {}, "wX:p1"), "wJ");
  assert.equal(workspaceIdFrom({}, { data: { workspace_id: "wK" } }, "wX:p1"), "wK");
  assert.equal(workspaceIdFrom({}, {}, "wJ:p1"), "wJ");
  assert.equal(workspaceIdFrom({}, {}, ""), undefined);
});

test("fetchWorktreeInfo picks the entry belonging to this workspace", () => {
  const linked = fetchWorktreeInfo("wJ", fakeHerdr);
  assert.equal(linked.repo_name, "sample-portal");
  assert.equal(linked.checkout_path, CHECKOUT);
  assert.equal(linked.is_linked_worktree, true);
  assert.equal(linked.branch, "build_deploy_plan");

  const source = fetchWorktreeInfo("w8", fakeHerdr);
  assert.equal(source.is_linked_worktree, false);
  assert.equal(source.branch, "main");

  assert.equal(fetchWorktreeInfo("wZ", fakeHerdr), undefined);
  assert.equal(fetchWorktreeInfo(undefined, fakeHerdr), undefined);
});

test("resolveWorktree works for a plain checkout, which carries no worktree block", () => {
  const info = resolveWorktree({ workspace_id: "wG" }, {}, "wG:p1", fakeHerdr);
  assert.equal(info.repo_name, "billing-worker");
  assert.equal(info.branch, "develop5");
  assert.equal(info.is_linked_worktree, false);
  assert.equal(resolveWorktree({}, {}, "wZ:p1", fakeHerdr), undefined);
});

test("formatWhere names the repo and the task, without repeating the workspace", () => {
  const linked = formatWhere(
    {
      workspace_id: "wJ",
      workspace_label: "build-deploy-plan",
      worktree: resolveWorktree({ workspace_id: "wJ" }, {}, "wJ:p1", fakeHerdr),
    },
    { data: { pane_id: "wJ:p1" } },
  );
  assert.equal(linked, "sample-portal · build-deploy-plan · pane 1");

  const branch = formatWhere(
    {
      workspace_id: "wG",
      workspace_label: "billing-worker",
      worktree: resolveWorktree({ workspace_id: "wG" }, {}, "wG:p1", fakeHerdr),
    },
    { data: { pane_id: "wG:p1" } },
  );
  assert.equal(branch, "billing-worker · develop5 · pane 1");

  const onMain = formatWhere(
    {
      workspace_id: "w8",
      workspace_label: "sample-portal",
      worktree: resolveWorktree({ workspace_id: "w8" }, {}, "w8:p1", fakeHerdr),
    },
    { data: { pane_id: "w8:p1" } },
  );
  assert.equal(onMain, "sample-portal · main · pane 1");
});
