import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pollerLogPath, rotatePollerLog, withTimestamps } from "../src/inbound/poller.mjs";

function withStateDir(body) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-pollerlog-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    body(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the log sits in the state dir, next to the pid", () => {
  withStateDir((dir) => {
    assert.equal(pollerLogPath(), join(dir, "poller.log"));
  });
});

test("a log under the cap is left alone", () => {
  withStateDir((dir) => {
    const path = join(dir, "poller.log");
    writeFileSync(path, "one line\n", "utf8");
    assert.equal(rotatePollerLog(path, 1024), false);
    assert.equal(readFileSync(path, "utf8"), "one line\n");
  });
});

test("a log over the cap moves aside so the crash that filled it survives", () => {
  withStateDir((dir) => {
    const path = join(dir, "poller.log");
    writeFileSync(path, "x".repeat(2048), "utf8");
    assert.equal(rotatePollerLog(path, 1024), true);
    assert.equal(statSync(`${path}.1`).size, 2048);
    assert.throws(() => statSync(path));
  });
});

test("a second rotation overwrites the first, so two files is the ceiling", () => {
  withStateDir((dir) => {
    const path = join(dir, "poller.log");
    writeFileSync(`${path}.1`, "older", "utf8");
    writeFileSync(path, "y".repeat(2048), "utf8");
    assert.equal(rotatePollerLog(path, 1024), true);
    assert.equal(readFileSync(`${path}.1`, "utf8"), "y".repeat(2048));
  });
});

test("a missing log is not an error, because the poller still has to start", () => {
  withStateDir((dir) => {
    assert.equal(rotatePollerLog(join(dir, "poller.log"), 1024), false);
  });
});

test("every line the poller prints carries the time it happened", () => {
  const lines = [];
  const fake = {
    log: (...args) => lines.push(["log", ...args]),
    error: (...args) => lines.push(["error", ...args]),
  };
  withTimestamps(fake, () => "2026-09-13T10:00:00.000Z");
  fake.log("oncall poller started pid=1");
  fake.error("Conflict: terminated by other getUpdates request");
  assert.deepEqual(lines, [
    ["log", "2026-09-13T10:00:00.000Z", "oncall poller started pid=1"],
    ["error", "2026-09-13T10:00:00.000Z", "Conflict: terminated by other getUpdates request"],
  ]);
});
