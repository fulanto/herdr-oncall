import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FEISHU_KEYS,
  consumePairCode,
  extractStartPayload,
  feishuPairId,
  feishuPaired,
  feishuVerifyCreds,
  pairDeepLink,
  pendingPair,
  saveFeishuPairing,
  startFeishuPairing,
  startPairing,
  unpairFeishu,
  upsertEnvValue,
  writeFeishuPair,
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

// Pairing Feishu, against fakes for every edge: no network, no bot, no panel.
// `calls` records what each step reached for.
const PAIRED = {
  FEISHU_APP_ID: "cli_paired",
  FEISHU_APP_SECRET: "secret",
  FEISHU_OPEN_ID: "ou_paired",
  FEISHU_DOMAIN: "feishu",
  CHANNEL: "feishu",
};
const UNPAIR_COMMAND = "herdr plugin action invoke unpair-feishu --plugin com.codreamer.herdr.oncall";

function harness(env, { verify = { ok: true }, sendFails = false, panel = true, pending } = {}) {
  const calls = { verify: 0, begin: 0, send: [], panel: [], setEnv: [], restart: 0, cancel: 0, log: [], error: [] };
  const deps = {
    env,
    verify: async (creds) => {
      calls.verify++;
      return typeof verify === "function" ? verify(creds) : verify;
    },
    begin: async () => {
      calls.begin++;
      return { deviceCode: "dc_test", url: "https://example.test/scan", interval: 5, expiresIn: 600 };
    },
    send: async (creds, openId, text) => {
      calls.send.push({ appId: creds.appId, openId, text });
      if (sendFails) {
        throw new Error("230013 bot has no availability to this user");
      }
      return "om_test";
    },
    panel: panel
      ? async (args) => {
          calls.panel.push(args);
          return { kind: "button", index: 0 };
        }
      : undefined,
    setEnv: (key, value) => {
      calls.setEnv.push([key, value]);
      env[key] = value;
    },
    // Never the real one here: it would reach the real state dir.
    cancelPending: () => {
      calls.cancel++;
      return pending;
    },
    restartPoller: () => {
      calls.restart++;
      return 4242;
    },
    log: (line) => calls.log.push(line),
    error: (line) => calls.error.push(line),
  };
  return { deps, calls };
}

test("pair-feishu: a machine already paired with working credentials is not registered again", async () => {
  const { deps, calls } = harness({ ...PAIRED });
  const result = await startFeishuPairing(deps);
  assert.equal(calls.begin, 0, "no registration, so no second bot");
  assert.deepEqual(result, { code: 0 });
  assert.equal(calls.verify, 1);
  const log = calls.log.join("\n");
  assert.match(log, /^feishu: already paired · app cli_paired · open_id ou_paired$/m);
  assert.ok(log.includes(`to pair again, unpair first: ${UNPAIR_COMMAND}`), log);
  assert.match(log, /已经配对过飞书.*请先解绑/);
  assert.deepEqual(calls.send, [
    { appId: "cli_paired", openId: "ou_paired", text: "already paired · this machine sends oncall here" },
  ]);
  assert.equal(calls.panel.length, 1);
  assert.equal(calls.panel[0].where, "Already paired");
  assert.ok(calls.panel[0].body.includes(UNPAIR_COMMAND), calls.panel[0].body);
  assert.match(calls.panel[0].body, /请先解绑/);
  // CHANNEL already says feishu: nothing to write, no poller to restart.
  assert.deepEqual(calls.setEnv, []);
  assert.equal(calls.restart, 0);
});

test("pair-feishu: an unpaired machine starts a registration", async () => {
  for (const env of [{ CHANNEL: "telegram" }, { FEISHU_APP_ID: "cli_half", FEISHU_APP_SECRET: "s" }]) {
    const { deps, calls } = harness(env);
    const result = await startFeishuPairing(deps);
    assert.equal(calls.begin, 1, JSON.stringify(env));
    assert.equal(calls.verify, 0, "nothing paired, nothing to check");
    assert.equal(result.begun.deviceCode, "dc_test");
    assert.deepEqual(calls.send, []);
  }
});

test("pair-feishu: credentials Feishu refuses start a new registration, and the log says why", async () => {
  const { deps, calls } = harness(
    { ...PAIRED },
    { verify: { ok: false, rejected: true, detail: "10015 wrong app secret" } },
  );
  const result = await startFeishuPairing(deps);
  assert.equal(calls.begin, 1);
  assert.equal(result.begun.url, "https://example.test/scan");
  assert.ok(
    calls.log.some((line) => line.includes("cli_paired was refused by Feishu (10015 wrong app secret)")),
    calls.log.join("\n"),
  );
  assert.deepEqual(calls.send, [], "a refused bot cannot be messaged");
});

test("pair-feishu: credentials that cannot be checked are kept, nothing is registered, exit 1", async () => {
  const { deps, calls } = harness(
    { ...PAIRED },
    { verify: { ok: false, rejected: false, detail: "fetch failed · getaddrinfo ENOTFOUND open.feishu.cn" } },
  );
  const result = await startFeishuPairing(deps);
  assert.equal(calls.begin, 0, "an outage is no reason to make a second bot");
  assert.deepEqual(result, { code: 1 });
  const errors = calls.error.join("\n");
  assert.match(errors, /Feishu could not confirm the pairing: fetch failed/);
  assert.match(errors, /no new bot created; try again later/);
  assert.ok(errors.includes(UNPAIR_COMMAND), errors);
  assert.deepEqual(calls.setEnv, []);
});

test("pair-feishu: an already-paired machine whose CHANNEL leaves Feishu out is set to feishu", async () => {
  const env = { ...PAIRED, CHANNEL: "telegram" };
  const { deps, calls } = harness(env);
  const result = await startFeishuPairing(deps);
  assert.equal(calls.begin, 0);
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(calls.setEnv, [["CHANNEL", "feishu"]]);
  assert.equal(env.CHANNEL, "feishu");
  assert.equal(calls.restart, 1, "the poller restarts onto the new CHANNEL");
  assert.ok(calls.log.includes("CHANNEL set to feishu · poller 4242"), calls.log.join("\n"));
});

test("pair-feishu: an already-paired message that fails is reported, and still nothing is registered", async () => {
  const { deps, calls } = harness({ ...PAIRED }, { sendFails: true, panel: true });
  const result = await startFeishuPairing(deps);
  assert.equal(calls.begin, 0);
  assert.deepEqual(result, { code: 1 });
  assert.match(calls.error.join("\n"), /already paired, but the message to it failed: 230013/);
  assert.match(calls.panel[0].body, /But the message to Feishu failed:\n230013/);
});

// The one check the decision above rests on, against a fake Feishu.
function fakeFeishu(status, body) {
  return async () => ({ ok: status < 400, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
}

test("pair-feishu: the credentials check tells a refusal from an outage", async () => {
  const creds = { appId: "cli_paired", appSecret: "secret", brand: "feishu" };
  assert.deepEqual(
    await feishuVerifyCreds(creds, { fetchImpl: fakeFeishu(200, { code: 0, tenant_access_token: "t", expire: 7200 }) }),
    { ok: true },
  );
  // Only the codes that say the app itself is dead: 10014 app unauthorized
  // (disabled), 10015 wrong app secret.
  for (const [code, msg] of [
    [10014, "app unauthorized"],
    [10015, "wrong app secret"],
  ]) {
    assert.deepEqual(await feishuVerifyCreds(creds, { fetchImpl: fakeFeishu(400, { code, msg }) }), {
      ok: false,
      rejected: true,
      detail: `${code} ${msg}`,
    });
  }

  const offline = await feishuVerifyCreds(creds, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.rejected, false);
  // Everything else is an answer about something other than the bot: an
  // access-control policy (21001 arrives as HTTP 200 and has cleared up by
  // itself, larksuite/openclaw-lark#639), a vague parameter or token failure,
  // a rate limit, a server error.
  for (const [status, body] of [
    [200, { code: 21001, msg: "access denied by access control policy" }],
    [400, { code: 10003, msg: "invalid parameter" }],
    [400, { code: 10013, msg: "get tenant access token fail" }],
    [503, "<html>bad gateway</html>"],
    [429, { code: 99991400, msg: "request trigger frequency limit" }],
    [200, { code: 99991400, msg: "request trigger frequency limit" }],
  ]) {
    const result = await feishuVerifyCreds(creds, { fetchImpl: fakeFeishu(status, body) });
    assert.equal(result.ok, false);
    assert.equal(result.rejected, false, `${status} ${JSON.stringify(body)}`);
  }
});

// The same decision end to end, through the real check against a fake Feishu.
test("pair-feishu: a policy refusal (21001) keeps the pairing and registers nothing; a wrong secret registers anew", async () => {
  const policy = harness(
    { ...PAIRED },
    {
      verify: (creds) =>
        feishuVerifyCreds(creds, { fetchImpl: fakeFeishu(200, { code: 21001, msg: "access denied by access control policy" }) }),
    },
  );
  assert.deepEqual(await startFeishuPairing(policy.deps), { code: 1 });
  assert.equal(policy.calls.begin, 0, "21001 says nothing about the bot; no second one");
  assert.match(policy.calls.error.join("\n"), /could not confirm the pairing: 21001 access denied/);

  const dead = harness(
    { ...PAIRED },
    { verify: (creds) => feishuVerifyCreds(creds, { fetchImpl: fakeFeishu(400, { code: 10015, msg: "wrong app secret" }) }) },
  );
  const result = await startFeishuPairing(dead.deps);
  assert.equal(dead.calls.begin, 1);
  assert.equal(result.begun.deviceCode, "dc_test");
});

test("unpair-feishu: clears FEISHU_* so feishuPaired() is false, and takes feishu out of CHANNEL", async () => {
  const env = { ...PAIRED, CHANNEL: "telegram,feishu" };
  const { deps, calls } = harness(env);
  assert.equal(feishuPaired(env), true);
  const code = await unpairFeishu(deps);
  assert.equal(code, 0);
  for (const key of FEISHU_KEYS) {
    assert.equal(env[key], "", key);
  }
  assert.equal(feishuPaired(env), false);
  assert.equal(env.CHANNEL, "telegram");
  assert.equal(calls.restart, 1);
  assert.deepEqual(calls.send, [
    { appId: "cli_paired", openId: "ou_paired", text: "unpaired · this machine no longer sends oncall here" },
  ]);
  const log = calls.log.join("\n");
  assert.match(log, /^feishu unpaired · app cli_paired removed from \.env · CHANNEL=telegram · poller 4242$/m);
  assert.match(log, /old bot is still in Feishu; delete app cli_paired at https:\/\/open\.feishu\.cn\/app/);
  assert.match(log, /pair-feishu now creates a new bot/);
  assert.match(log, /已解绑飞书/);
});

test("unpair-feishu: Feishu as the only channel falls back to telegram, the empty CHANNEL default", async () => {
  const env = { ...PAIRED, CHANNEL: "feishu" };
  const { deps } = harness(env);
  assert.equal(await unpairFeishu(deps), 0);
  assert.equal(env.CHANNEL, "telegram");
});

test("unpair-feishu: an unpaired machine has nothing to unpair and exits 0", async () => {
  const env = { CHANNEL: "telegram", FEISHU_APP_ID: "", FEISHU_OPEN_ID: " " };
  const { deps, calls } = harness(env);
  assert.equal(await unpairFeishu(deps), 0);
  // No scan in progress: the output is exactly what it was before scans could
  // be withdrawn.
  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.log, ["feishu: not paired, nothing to unpair", "飞书没有配对，不用解绑。"]);
  assert.deepEqual(calls.setEnv, []);
  assert.equal(calls.restart, 0);
  assert.deepEqual(calls.send, []);
});

test("unpair-feishu: a scan in progress is withdrawn and said so, paired or not", async () => {
  const pending = { id: "scan_1", deviceCode: "dc_pending" };
  const unpaired = harness({ CHANNEL: "telegram" }, { pending });
  assert.equal(await unpairFeishu(unpaired.deps), 0);
  assert.deepEqual(unpaired.calls.log, [
    "feishu: cancelled the scan in progress, so it cannot pair this machine afterwards",
    "feishu: not paired, nothing to unpair",
    "飞书没有配对，不用解绑。",
  ]);

  const env = { ...PAIRED };
  const paired = harness(env, { pending });
  assert.equal(await unpairFeishu(paired.deps), 0);
  assert.equal(paired.calls.log[0], "feishu: cancelled the scan in progress, so it cannot pair this machine afterwards");
  assert.equal(feishuPaired(env), false);
});

// The race the review found: pair-feishu's worker is still waiting on a scan
// when unpair-feishu runs, and Feishu approves the scan afterwards. Through the
// real scan record on disk: unpair removes it, and the worker's save, which
// asks whether the scan is still its own, writes nothing.
test("unpair-feishu: a scan withdrawn by unpairing is not written back by its worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-scan-"));
  const previous = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    writeFeishuPair({ id: "scan_1", deviceCode: "dc_pending", url: "https://example.test/scan", interval: 5, exp: Date.now() + 600_000 });
    assert.equal(feishuPairId(), "scan_1");

    const env = { ...PAIRED };
    const { deps, calls } = harness(env);
    delete deps.cancelPending;
    assert.equal(await unpairFeishu(deps), 0);
    assert.equal(feishuPairId(), undefined, "the scan record is gone");
    assert.match(calls.log[0], /cancelled the scan in progress/);

    // Feishu approves the scan now; the worker tries to save it.
    const written = [];
    const log = [];
    const saved = saveFeishuPairing(
      { kind: "paired", appId: "cli_late", appSecret: "late", openId: "ou_late", brand: "feishu" },
      { id: "scan_1", env, setEnv: (key, value) => written.push([key, value]), log: (line) => log.push(line) },
    );
    assert.equal(saved, false);
    assert.deepEqual(written, [], "nothing reaches .env");
    assert.equal(feishuPaired(env), false);
    assert.match(log.join("\n"), /withdrawn before its result was saved.*not saving app cli_late/);
    assert.match(log.join("\n"), /still created app cli_late in Feishu; delete it at https:\/\/open\.feishu\.cn\/app/);
  } finally {
    if (previous === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pair-feishu: a scan still owned by its worker is saved, and sets CHANNEL as before", () => {
  const env = { CHANNEL: "telegram" };
  const written = [];
  const saved = saveFeishuPairing(
    { kind: "paired", appId: "cli_new", appSecret: "s", openId: "ou_new", brand: "lark" },
    {
      id: "scan_2",
      env,
      owns: () => true,
      setEnv: (key, value) => {
        written.push([key, value]);
        env[key] = value;
      },
      log: () => {},
    },
  );
  assert.equal(saved, true);
  assert.deepEqual(written, [
    ["FEISHU_APP_ID", "cli_new"],
    ["FEISHU_APP_SECRET", "s"],
    ["FEISHU_OPEN_ID", "ou_new"],
    ["FEISHU_DOMAIN", "lark"],
    ["CHANNEL", "feishu"],
  ]);
  assert.equal(feishuPaired(env), true);
});

test("unpair-feishu: a failed goodbye message does not stop the unpairing", async () => {
  const env = { ...PAIRED };
  const { deps, calls } = harness(env, { sendFails: true });
  assert.equal(await unpairFeishu(deps), 0);
  assert.equal(feishuPaired(env), false);
  assert.match(calls.error.join("\n"), /unpaired message failed \(230013 .*\); unpairing anyway/);
});

test("unpair-feishu: pair-feishu after unpairing starts a new registration", async () => {
  const env = { ...PAIRED };
  const unpair = harness(env);
  assert.equal(await unpairFeishu(unpair.deps), 0);
  const pair = harness(env);
  const result = await startFeishuPairing(pair.deps);
  assert.equal(pair.calls.verify, 0);
  assert.equal(pair.calls.begin, 1);
  assert.equal(result.begun.deviceCode, "dc_test");
});

// The same, through the real .env writer: the file a later process reads must
// say unpaired too, not only this process's environment.
test("unpair-feishu: the .env on disk is emptied and its CHANNEL put back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-unpair-"));
  const keys = ["HERDR_PLUGIN_CONFIG_DIR", "CHANNEL", ...FEISHU_KEYS];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  try {
    writeFileSync(
      join(dir, ".env"),
      "CHANNEL=feishu\nFEISHU_APP_ID=cli_paired\nFEISHU_APP_SECRET=secret\nFEISHU_OPEN_ID=ou_paired\nFEISHU_DOMAIN=feishu\n",
    );
    Object.assign(process.env, PAIRED);
    const { calls, deps } = harness(process.env);
    delete deps.setEnv;
    assert.equal(await unpairFeishu(deps), 0);
    const written = readFileSync(join(dir, ".env"), "utf8");
    for (const key of FEISHU_KEYS) {
      assert.match(written, new RegExp(`^${key}=$`, "m"), key);
    }
    assert.match(written, /^CHANNEL=telegram$/m);
    assert.equal(feishuPaired(), false);
    assert.equal(calls.restart, 1);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
