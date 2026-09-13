import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDotEnv } from "../src/lib/index.mjs";

const KEYS = ["HERDR_PLUGIN_CONFIG_DIR", "HERDR_BIN_PATH", "ONCALL_PROBE"];

function withEnv(body) {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "oncall-dotenv-"));
  try {
    body(dir);
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Stands in for the herdr binary, answering `plugin config-dir <id>` the way the
// real one does.
function fakeHerdr(dir) {
  const path = join(dir, "herdr");
  writeFileSync(path, `#!/bin/sh\n[ "$1" = "plugin" ] && [ "$2" = "config-dir" ] && echo '${dir}'\n`);
  chmodSync(path, 0o755);
  return path;
}

test("a shell-started process finds the .env by asking herdr", () => {
  withEnv((dir) => {
    writeFileSync(join(dir, ".env"), "ONCALL_PROBE=from-the-config-dir\n", "utf8");
    // Herdr sets HERDR_PLUGIN_CONFIG_DIR for events and actions and for nothing
    // else. Resolving the config directory from that variable alone is what
    // left the poller install.sh spawns with no token and no way to say so.
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.ONCALL_PROBE;
    process.env.HERDR_BIN_PATH = fakeHerdr(dir);
    loadDotEnv();
    assert.equal(process.env.ONCALL_PROBE, "from-the-config-dir");
  });
});

test("the directory Herdr hands over still wins outright", () => {
  withEnv((dir) => {
    writeFileSync(join(dir, ".env"), "ONCALL_PROBE=from-the-given-dir\n", "utf8");
    delete process.env.ONCALL_PROBE;
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    // No fake binary: resolving must not need one when the variable is there.
    process.env.HERDR_BIN_PATH = join(dir, "does-not-exist");
    loadDotEnv();
    assert.equal(process.env.ONCALL_PROBE, "from-the-given-dir");
  });
});

test("a value already in the environment is never overwritten", () => {
  withEnv((dir) => {
    const path = join(dir, "other.env");
    writeFileSync(path, "ONCALL_PROBE=from-the-file\n", "utf8");
    process.env.ONCALL_PROBE = "already here";
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "already here");
  });
});

test("a missing .env is not an error", () => {
  withEnv((dir) => {
    delete process.env.ONCALL_PROBE;
    loadDotEnv(join(dir, "nothing-here.env"));
    assert.equal(process.env.ONCALL_PROBE, undefined);
  });
});
