import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchWorktreeBranch,
  formatWhere,
  resolveWorktree,
  workspaceIdFrom,
  worktreeLabel,
  worktreeName,
} from "../src/lib/index.mjs";

const linked = {
  checkout_path: "/Users/me/.herdr/worktrees/trizen-doctor/build-deploy-plan",
  is_linked_worktree: true,
  repo_name: "trizen-doctor",
  repo_root: "/Users/me/Git-Repo/trizen/trizen-doctor",
};

const workspaceGet = JSON.stringify({
  result: { workspace: { workspace_id: "wJ", label: "build-deploy-plan", worktree: linked } },
});
const worktreeList = JSON.stringify({
  result: {
    worktrees: [
      { branch: "main", is_linked_worktree: false, open_workspace_id: "w8", path: linked.repo_root },
      { branch: "build_deploy_plan", is_linked_worktree: true, open_workspace_id: "wJ", path: linked.checkout_path },
    ],
  },
});

function fakeHerdr(args) {
  const key = args.join(" ");
  if (key === "workspace get wJ") {
    return { status: 0, stdout: workspaceGet };
  }
  if (key === "worktree list --workspace wJ") {
    return { status: 0, stdout: worktreeList };
  }
  return { status: 1, stdout: "", stderr: `unexpected ${key}` };
}

test("worktreeName only names linked worktrees", () => {
  assert.equal(worktreeName(linked), "build-deploy-plan");
  assert.equal(worktreeName({ ...linked, is_linked_worktree: false }), undefined);
  assert.equal(worktreeName(undefined), undefined);
});

test("worktreeLabel names the worktree, and the branch only when it differs", () => {
  assert.equal(worktreeLabel({ ...linked, branch: "build_deploy_plan" }), "build-deploy-plan");
  assert.equal(worktreeLabel({ ...linked, branch: "build-deploy-plan" }), "build-deploy-plan");
  assert.equal(worktreeLabel({ ...linked, branch: "Build/Deploy/Plan" }), "build-deploy-plan");
  assert.equal(worktreeLabel(linked), "build-deploy-plan");
  assert.equal(
    worktreeLabel({ ...linked, branch: "feature/TRZN-7298" }),
    "build-deploy-plan (feature/TRZN-7298)",
  );
});

test("workspaceIdFrom falls back to the pane id prefix", () => {
  assert.equal(workspaceIdFrom({ workspace_id: "wJ" }, {}, "wX:p1"), "wJ");
  assert.equal(workspaceIdFrom({}, { data: { workspace_id: "wK" } }, "wX:p1"), "wK");
  assert.equal(workspaceIdFrom({}, {}, "wJ:p1"), "wJ");
  assert.equal(workspaceIdFrom({}, {}, ""), undefined);
});

test("fetchWorktreeBranch matches by checkout path", () => {
  assert.equal(fetchWorktreeBranch("wJ", linked.checkout_path, fakeHerdr), "build_deploy_plan");
  assert.equal(fetchWorktreeBranch("wZ", linked.checkout_path, fakeHerdr), undefined);
});

test("resolveWorktree uses context first and fills in the branch from herdr", () => {
  const fromContext = resolveWorktree({ worktree: linked }, {}, "wJ:p1", fakeHerdr);
  assert.equal(fromContext.branch, "build_deploy_plan");
  const fromHerdr = resolveWorktree({}, {}, "wJ:p1", fakeHerdr);
  assert.equal(fromHerdr.checkout_path, linked.checkout_path);
  assert.equal(fromHerdr.branch, "build_deploy_plan");
  const plain = resolveWorktree({ worktree: { ...linked, is_linked_worktree: false } }, {}, "wJ:p1", fakeHerdr);
  assert.equal(plain.branch, undefined);
  assert.equal(resolveWorktree({}, {}, "", fakeHerdr), undefined);
});

test("formatWhere names the worktree and does not repeat it as the space", () => {
  const where = formatWhere(
    { workspace_id: "wJ", workspace_label: "build-deploy-plan", worktree: { ...linked, branch: "build_deploy_plan" } },
    { data: { pane_id: "wJ:p1" } },
  );
  assert.equal(where, "trizen-doctor · build-deploy-plan · pane 1");
  const main = formatWhere(
    { workspace_id: "w8", workspace_label: "trizen-doctor", worktree: { ...linked, is_linked_worktree: false } },
    { data: { pane_id: "w8:p1" } },
  );
  assert.equal(main, "trizen-doctor · pane 1");
});
