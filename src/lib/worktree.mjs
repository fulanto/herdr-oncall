import { basename } from "node:path";
import { runHerdr } from "./paths.mjs";

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseJson(result) {
  if (result?.error || result?.status !== 0 || !result.stdout?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

export function workspaceIdFrom(context = {}, event = {}, paneId = "") {
  const direct = firstString(context.workspace_id, event?.data?.workspace_id);
  if (direct) {
    return direct;
  }
  const match = String(paneId).match(/^(w[0-9A-Za-z]+):/);
  return match ? match[1] : undefined;
}

export function worktreeFrom(context = {}, event = {}) {
  const raw = context.worktree ?? event?.data?.worktree;
  return raw && typeof raw === "object" ? raw : undefined;
}

export function worktreeName(worktree) {
  if (!worktree?.is_linked_worktree) {
    return undefined;
  }
  const path = firstString(worktree.checkout_path, worktree.path);
  if (!path) {
    return undefined;
  }
  const name = basename(path.replace(/[\\/]+$/, ""));
  return name && name !== "." ? name : undefined;
}

export function fetchWorkspaceWorktree(workspaceId, run = runHerdr) {
  if (!workspaceId) {
    return undefined;
  }
  const json = parseJson(run(["workspace", "get", workspaceId]));
  const worktree = json?.result?.workspace?.worktree ?? json?.workspace?.worktree ?? json?.worktree;
  return worktree && typeof worktree === "object" ? worktree : undefined;
}

export function fetchWorktreeBranch(workspaceId, checkoutPath, run = runHerdr) {
  if (!workspaceId) {
    return undefined;
  }
  const json = parseJson(run(["worktree", "list", "--workspace", workspaceId]));
  const list = json?.result?.worktrees ?? json?.worktrees;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const target = String(checkoutPath || "").replace(/[\\/]+$/, "");
  const hit =
    list.find((item) => String(item?.path || "").replace(/[\\/]+$/, "") === target) ??
    list.find((item) => item?.open_workspace_id === workspaceId);
  return firstString(hit?.branch);
}

export function resolveWorktree(context = {}, event = {}, paneId = "", run = runHerdr) {
  const workspaceId = workspaceIdFrom(context, event, paneId);
  let worktree = worktreeFrom(context, event);
  if (!worktree) {
    worktree = fetchWorkspaceWorktree(workspaceId, run);
  }
  if (!worktree) {
    return undefined;
  }
  const merged = { ...worktree };
  if (merged.is_linked_worktree && !firstString(merged.branch)) {
    const branch = fetchWorktreeBranch(workspaceId, merged.checkout_path ?? merged.path, run);
    if (branch) {
      merged.branch = branch;
    }
  }
  return merged;
}

export function worktreeLabel(worktree) {
  const name = worktreeName(worktree);
  if (!name) {
    return undefined;
  }
  const branch = firstString(worktree.branch);
  if (branch && branch.toLowerCase() !== name.toLowerCase()) {
    return `worktree ${name} (${branch})`;
  }
  return `worktree ${name}`;
}
