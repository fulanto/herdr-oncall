import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  consumePairCode,
  extractStartPayload,
  pairDeepLink,
  pendingPair,
  startPairing,
  upsertEnvValue,
} from "../src/lib/index.mjs";

test("extractStartPayload reads /start CODE", () => {
  assert.equal(extractStartPayload("/start AB23CD"), "AB23CD");
  assert.equal(extractStartPayload("/start@mybot AB23CD"), "AB23CD");
  assert.equal(extractStartPayload("/start"), undefined);
  assert.equal(extractStartPayload("hello"), undefined);
});

test("consumePairCode accepts the pending code once", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-pair-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    const record = startPairing({ botUsername: "oncallbot", now: 1000, ttlMs: 60_000 });
    assert.equal(pendingPair(1000)?.code, record.code);
    assert.deepEqual(consumePairCode(`/start ${record.code}`, 2000), { ok: true, code: record.code });
    assert.equal(pendingPair(2000), undefined);
    assert.equal(consumePairCode(`/start ${record.code}`, 3000).ok, false);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pairDeepLink builds a t.me start url", () => {
  assert.equal(pairDeepLink("oncallbot", "AB23CD"), "https://t.me/oncallbot?start=AB23CD");
  assert.equal(pairDeepLink("@oncallbot", "AB23CD"), "https://t.me/oncallbot?start=AB23CD");
});

test("upsertEnvValue writes chat id without clobbering the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-env-"));
  const previous = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  try {
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=keep\nTELEGRAM_CHAT_ID=\n");
    upsertEnvValue("TELEGRAM_CHAT_ID", "12345");
    const env = readFileSync(join(dir, ".env"), "utf8");
    assert.match(env, /TELEGRAM_BOT_TOKEN=keep/);
    assert.match(env, /TELEGRAM_CHAT_ID=12345/);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    } else {
      process.env.HERDR_PLUGIN_CONFIG_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
