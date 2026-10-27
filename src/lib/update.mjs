import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envFlag } from "./config.mjs";
import { PLUGIN_ID, herdrBin, stateDir } from "./paths.mjs";

// Installs follow releases, and Herdr does the updating. CI moves the `stable`
// branch to each released commit (.github/workflows/test.yml), an install made
// with `--ref stable` records that ref, and `herdr plugin update` refetches the
// recorded ref: an unmoved commit is "already up to date", a moved one is
// checked out into a new installation directory and built there (the panel
// is recompiled) while running processes keep the old files. Herdr never
// updates on its own, so the poller asks it to every few hours.
export const STABLE_REF = "stable";
export const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
// A poller restarts on every Herdr start and every config action; a check
// per restart would be a git fetch per pairing attempt.
const MIN_GAP_MS = 30 * 60 * 1000;

// A herdr call that may take minutes (an update builds the panel) must not
// stall the poller, whose replies keep arriving meanwhile.
export function runHerdrAsync(args, { timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(herdrBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ error });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error, stdout, stderr });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// This plugin's entry in `herdr plugin list --json`: its version and how it
// was installed — `source.kind` "local" for a linked checkout, "github" with
// owner, repo, subdir, requested_ref and resolved_commit otherwise.
export function extractPluginInfo(payload, id = PLUGIN_ID) {
  const plugins = payload?.result?.plugins ?? payload?.plugins ?? [];
  const plugin = plugins.find((item) => item?.plugin_id === id);
  return plugin ? { version: plugin.version, source: plugin.source ?? {} } : undefined;
}

async function pluginInfo(run) {
  const result = await run(["plugin", "list", "--json", "--plugin", PLUGIN_ID]);
  if (result?.error || result?.status !== 0) {
    return undefined;
  }
  try {
    return extractPluginInfo(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export async function remoteBranchExists(owner, repo, branch, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/branches/${branch}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "herdr-oncall" },
      signal: AbortSignal.timeout(15_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function checkPath() {
  return join(stateDir(), "update-check.json");
}

function lastCheck() {
  try {
    return Number(JSON.parse(readFileSync(checkPath(), "utf8")).at) || 0;
  } catch {
    return 0;
  }
}

function markCheck(now) {
  try {
    mkdirSync(dirname(checkPath()), { recursive: true });
    writeFileSync(checkPath(), JSON.stringify({ at: now }), "utf8");
  } catch {
    /* a check that cannot be recorded just happens again next time */
  }
}

function failureText(result) {
  return (result?.stderr || result?.stdout || result?.error?.message || `exit ${result?.status}`).trim();
}

// One update check. Returns { skipped: reason } | { current: true, version } |
// { updated: true, from, to, url } | { failed: true, detail }.
// A checkout linked for development is never touched: it is someone's working
// tree. `AUTO_UPDATE=0` turns the whole thing off.
export async function checkForUpdate({
  run = runHerdrAsync,
  fetchImpl = fetch,
  now = Date.now(),
  enabled = envFlag("AUTO_UPDATE", true),
  force = false,
} = {}) {
  if (!enabled) {
    return { skipped: "AUTO_UPDATE is off" };
  }
  if (!force && now - lastCheck() < MIN_GAP_MS) {
    return { skipped: "checked recently" };
  }
  const before = await pluginInfo(run);
  if (!before) {
    return { skipped: "not in herdr plugin list" };
  }
  if (before.source.kind !== "github") {
    return { skipped: "linked from a local checkout" };
  }
  markCheck(now);
  const { owner, repo, subdir } = before.source;
  let result;
  if (before.source.requested_ref !== STABLE_REF && (await remoteBranchExists(owner, repo, STABLE_REF, { fetchImpl }))) {
    // Installed before releases existed, it follows the default branch and
    // would pick up every unreleased commit. Moved onto the release branch
    // once; `plugin update` keeps it there from then on.
    result = await run(["plugin", "install", [owner, repo, subdir].filter(Boolean).join("/"), "--ref", STABLE_REF, "--yes"]);
  } else {
    result = await run(["plugin", "update", PLUGIN_ID, "--yes"]);
  }
  if (result?.error || result?.status !== 0) {
    return { failed: true, detail: failureText(result) };
  }
  const after = await pluginInfo(run);
  if (!after || after.source.resolved_commit === before.source.resolved_commit) {
    return { current: true, version: before.version };
  }
  return {
    updated: true,
    from: before.version,
    to: after.version,
    url: `https://github.com/${owner}/${repo}/releases/tag/v${after.version}`,
  };
}
