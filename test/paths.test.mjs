import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PLUGIN_ID, managedStateDir, stateDir } from "../src/lib/index.mjs";

// Every case here decides where state lands, so each one owns the three env
// vars that answer that question and hands them back untouched.
function withEnv(values, body) {
  const keys = ["HERDR_PLUGIN_STATE_DIR", "XDG_STATE_HOME", "HOME"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "oncall-paths-"));
  try {
    for (const key of keys) {
      const value = values[key] === undefined ? undefined : values[key](dir);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    body(dir);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the state dir Herdr passes in always wins", () => {
  withEnv(
    {
      HERDR_PLUGIN_STATE_DIR: (dir) => join(dir, "given"),
      XDG_STATE_HOME: (dir) => dir,
    },
    (dir) => {
      // Even with a managed directory sitting right there.
      mkdirSync(join(dir, "herdr", "plugins", PLUGIN_ID), { recursive: true });
      assert.equal(stateDir(), join(dir, "given"));
    },
  );
});

test("a shell run finds the same directory the hooks use", () => {
  withEnv({ XDG_STATE_HOME: (dir) => dir }, (dir) => {
    const managed = join(dir, "herdr", "plugins", PLUGIN_ID);
    mkdirSync(managed, { recursive: true });
    // This is the whole point: no HERDR_PLUGIN_STATE_DIR, yet one poller.pid.
    assert.equal(stateDir(), managed);
    assert.equal(managedStateDir(), managed);
  });
});

test("a debug build of Herdr keeps its own directory", () => {
  withEnv({ XDG_STATE_HOME: (dir) => dir }, (dir) => {
    const managed = join(dir, "herdr-dev", "plugins", PLUGIN_ID);
    mkdirSync(managed, { recursive: true });
    assert.equal(stateDir(), managed);
  });
});

test("a release directory wins over a debug one", () => {
  withEnv({ XDG_STATE_HOME: (dir) => dir }, (dir) => {
    mkdirSync(join(dir, "herdr-dev", "plugins", PLUGIN_ID), { recursive: true });
    mkdirSync(join(dir, "herdr", "plugins", PLUGIN_ID), { recursive: true });
    assert.equal(stateDir(), join(dir, "herdr", "plugins", PLUGIN_ID));
  });
});

test("without Herdr the old directory is still the answer", () => {
  withEnv({ XDG_STATE_HOME: (dir) => dir }, (dir) => {
    assert.equal(managedStateDir(), undefined);
    assert.equal(stateDir(), join(dir, "herdr-oncall"));
  });
});

test("HOME stands in for an unset XDG_STATE_HOME", () => {
  withEnv({ HOME: (dir) => dir }, (dir) => {
    const managed = join(dir, ".local", "state", "herdr", "plugins", PLUGIN_ID);
    mkdirSync(managed, { recursive: true });
    assert.equal(stateDir(), managed);
  });
});
