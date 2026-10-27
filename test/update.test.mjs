import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PLUGIN_ID, STABLE_REF, checkForUpdate, extractPluginInfo } from "../src/lib/index.mjs";

async function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-update-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// `herdr plugin list --json` as Herdr 0.9.5 prints it, cut down.
function listing(version, source) {
  return JSON.stringify({ id: "cli:plugin", result: { plugins: [{ plugin_id: PLUGIN_ID, version, source }], type: "plugin_list" } });
}

const github = (commit, ref) => ({
  kind: "github",
  owner: "fulanto",
  repo: "herdr-oncall",
  ...(ref ? { requested_ref: ref } : {}),
  resolved_commit: commit,
});

// Herdr as a script: each `plugin list` answers with the next listing, every
// other call is recorded and answered by `answer`.
function fakeHerdr(listings, calls, answer = () => ({ status: 0, stdout: "" })) {
  return async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "plugin" && args[1] === "list") {
      return { status: 0, stdout: listings.shift() };
    }
    return answer(args);
  };
}

const branch = (exists) => async () => ({ status: exists ? 200 : 404 });

test("the plugin's own entry is read from the listing", () => {
  const info = extractPluginInfo(JSON.parse(listing("0.6.3", github("abc", "stable"))));
  assert.deepEqual(info, { version: "0.6.3", source: github("abc", "stable") });
  assert.equal(extractPluginInfo({ result: { plugins: [{ plugin_id: "other" }] } }), undefined);
});

test("a checkout linked for development is never updated", async () => {
  await withStateDir(async () => {
    const calls = [];
    const outcome = await checkForUpdate({ run: fakeHerdr([listing("0.6.3", { kind: "local" })], calls), fetchImpl: branch(true) });
    assert.deepEqual(outcome, { skipped: "linked from a local checkout" });
    assert.deepEqual(calls, [`plugin list --json --plugin ${PLUGIN_ID}`]);
  });
});

test("AUTO_UPDATE=0 calls nothing at all", async () => {
  const calls = [];
  assert.deepEqual(await checkForUpdate({ run: fakeHerdr([], calls), enabled: false }), { skipped: "AUTO_UPDATE is off" });
  assert.deepEqual(calls, []);
});

test("an install on the release branch is updated by Herdr, and a moved commit is an update", async () => {
  await withStateDir(async () => {
    const calls = [];
    const outcome = await checkForUpdate({
      run: fakeHerdr([listing("0.6.3", github("old", STABLE_REF)), listing("0.6.4", github("new", STABLE_REF))], calls),
      fetchImpl: branch(true),
    });
    assert.deepEqual(outcome, {
      updated: true,
      from: "0.6.3",
      to: "0.6.4",
      url: "https://github.com/fulanto/herdr-oncall/releases/tag/v0.6.4",
    });
    assert.ok(calls.includes(`plugin update ${PLUGIN_ID} --yes`));
  });
});

test("nothing new released is nothing to do", async () => {
  await withStateDir(async () => {
    const calls = [];
    const outcome = await checkForUpdate({
      run: fakeHerdr([listing("0.6.3", github("same", STABLE_REF)), listing("0.6.3", github("same", STABLE_REF))], calls),
      fetchImpl: branch(true),
    });
    assert.deepEqual(outcome, { current: true, version: "0.6.3" });
  });
});

test("an install from before releases moves onto the release branch once", async () => {
  await withStateDir(async () => {
    const calls = [];
    // Installed without --ref: it follows the default branch.
    const outcome = await checkForUpdate({
      run: fakeHerdr([listing("0.6.3", github("main-head")), listing("0.6.4", github("release", STABLE_REF))], calls),
      fetchImpl: branch(true),
    });
    assert.equal(outcome.updated, true);
    assert.ok(calls.includes(`plugin install fulanto/herdr-oncall --ref ${STABLE_REF} --yes`), calls.join("\n"));
    assert.ok(!calls.some((call) => call.startsWith("plugin update")));
  });
});

test("with no release branch yet, the install is updated where it is", async () => {
  await withStateDir(async () => {
    const calls = [];
    await checkForUpdate({
      run: fakeHerdr([listing("0.6.3", github("a")), listing("0.6.3", github("a"))], calls),
      fetchImpl: branch(false),
    });
    assert.ok(calls.includes(`plugin update ${PLUGIN_ID} --yes`));
    assert.ok(!calls.some((call) => call.startsWith("plugin install")));
  });
});

test("a failed update says why, and a recent check is not repeated", async () => {
  await withStateDir(async () => {
    const calls = [];
    const now = Date.UTC(2026, 9, 27, 12);
    const failed = await checkForUpdate({
      run: fakeHerdr([listing("0.6.3", github("a", STABLE_REF))], calls, () => ({ status: 1, stderr: "git fetch failed\n" })),
      fetchImpl: branch(true),
      now,
    });
    assert.deepEqual(failed, { failed: true, detail: "git fetch failed" });

    const again = await checkForUpdate({ run: fakeHerdr([], calls), now: now + 60_000 });
    assert.deepEqual(again, { skipped: "checked recently" });
    const forced = await checkForUpdate({
      run: fakeHerdr([listing("0.6.3", github("a", STABLE_REF)), listing("0.6.3", github("a", STABLE_REF))], calls),
      fetchImpl: branch(true),
      now: now + 60_000,
      force: true,
    });
    assert.equal(forced.current, true);
  });
});
