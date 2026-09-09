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

// Only a linked worktree has a name of its own; a plain checkout's directory is
// just the repo.
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

// `herdr worktree list --workspace <id>` answers everything in one call, and
// unlike `workspace get` it reports the branch for plain checkouts too — those
// carry no `worktree` block at all, which is why a normal repo used to show
// nothing but its workspace label.
export function fetchWorktreeInfo(workspaceId, run = runHerdr) {
  if (!workspaceId) {
    return undefined;
  }
  const json = parseJson(run(["worktree", "list", "--workspace", workspaceId]));
  const result = json?.result ?? json;
  const list = result?.worktrees;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const source = result?.source ?? {};
  const hit =
    list.find((item) => item?.open_workspace_id === workspaceId) ??
    (list.length === 1 ? list[0] : undefined);
  if (!hit) {
    return undefined;
  }
  return {
    repo_name: firstString(source.repo_name, basenameOf(source.repo_root)),
    repo_root: firstString(source.repo_root),
    checkout_path: firstString(hit.path),
    is_linked_worktree: Boolean(hit.is_linked_worktree),
    branch: hit.is_detached ? undefined : firstString(hit.branch),
  };
}

function basenameOf(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const name = basename(value.trim().replace(/[\\/]+$/, ""));
  return name && name !== "." ? name : undefined;
}

export function resolveWorktree(context = {}, event = {}, paneId = "", run = runHerdr) {
  const workspaceId = workspaceIdFrom(context, event, paneId);
  const fetched = fetchWorktreeInfo(workspaceId, run);
  const carried = worktreeFrom(context, event);
  if (!fetched && !carried) {
    return undefined;
  }
  return { ...carried, ...dropEmpty(fetched) };
}

function dropEmpty(source) {
  const out = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

// What identifies this pane's task: a linked worktree's own name, or the
// branch of a plain checkout. `main` counts — knowing a pane sits on the
// default branch is as much a fact as any other branch.
export function worktreeLabel(worktree) {
  if (!worktree) {
    return undefined;
  }
  const branch = firstString(worktree.branch);
  const name = worktreeName(worktree);
  if (name) {
    return branch && !sameSlug(branch, name) ? `${name} (${branch})` : name;
  }
  return branch;
}

// The thing the workspace label would be repeating, if it repeats anything.
export function worktreeShortName(worktree) {
  return worktreeName(worktree) ?? firstString(worktree?.branch);
}

function sameSlug(a, b) {
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return slug(a) === slug(b);
}
