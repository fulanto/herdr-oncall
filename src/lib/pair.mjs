import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seedConfigEnv, setDotEnvValue } from "./config.mjs";
import { stateDir } from "./paths.mjs";

export const PAIR_TTL_MS = 10 * 60 * 1000;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function pairPath() {
  return join(stateDir(), "pair.json");
}

export function generatePairCode() {
  const bytes = randomBytes(6);
  let code = "";
  for (const byte of bytes) {
    code += ALPHABET[byte % ALPHABET.length];
  }
  return code;
}

export function startPairing({ botUsername = "", now = Date.now(), ttlMs = PAIR_TTL_MS } = {}) {
  const code = generatePairCode();
  const record = { code, exp: now + ttlMs, bot: String(botUsername || "").replace(/^@/, "") };
  mkdirSync(dirname(pairPath()), { recursive: true });
  writeFileSync(pairPath(), JSON.stringify(record), "utf8");
  return record;
}

export function pendingPair(now = Date.now()) {
  try {
    const record = JSON.parse(readFileSync(pairPath(), "utf8"));
    if (!record?.code || Number(record.exp) <= now) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

export function extractStartPayload(text) {
  const raw = String(text || "").trim();
  const start = raw.match(/^\/start(?:@\w+)?(?:\s+)([A-Za-z0-9_-]+)$/);
  if (start) {
    return start[1].toUpperCase();
  }
  return undefined;
}

export function consumePairCode(text, now = Date.now()) {
  const pending = pendingPair(now);
  if (!pending) {
    return { ok: false, reason: "no-pending" };
  }
  const offered = extractStartPayload(text) || String(text || "").trim().toUpperCase();
  if (!offered || offered === "/START") {
    return { ok: false, reason: "no-code" };
  }
  if (offered !== pending.code) {
    return { ok: false, reason: "mismatch" };
  }
  try {
    unlinkSync(pairPath());
  } catch {
    /* already gone */
  }
  return { ok: true, code: pending.code };
}

export function pairDeepLink(botUsername, code) {
  const user = String(botUsername || "").replace(/^@/, "");
  if (!user || !code) {
    return undefined;
  }
  return `https://t.me/${user}?start=${code}`;
}

export function upsertEnvValue(key, value) {
  const dest = seedConfigEnv();
  let content = readFileSync(dest, "utf8");
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, "m").test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    content = `${content.replace(/\s*$/, "")}\n${line}\n`;
  }
  writeFileSync(dest, content, "utf8");
  setDotEnvValue(key, String(value), dest);
  return dest;
}

export function printQr(url) {
  const printed = spawnSync("qrencode", ["-t", "ANSIUTF8", url], { encoding: "utf8" });
  if (printed.status === 0 && printed.stdout?.trim()) {
    console.log(printed.stdout);
    return;
  }
  // Install no longer fails without qrencode, so its absence is expected.
  if (printed.error?.code === "ENOENT") {
    console.log("(no QR code: qrencode is not installed, open the link above)");
    return;
  }
  const detail = printed.error?.message || printed.stderr?.trim() || `exit ${printed.status}`;
  console.error(`qrencode failed: ${detail}`);
}

// A Feishu scan in progress: the registration's device code, the page to scan,
// when it runs out, and a random `id` naming the worker that waits for it — the
// device code can redeem the app secret once approved, so it stays in this file
// and off any command line. Starting another pair overwrites the record, which
// is how a worker still waiting on the old one learns it has been replaced.
function feishuPairPath() {
  return join(stateDir(), "feishu-pair.json");
}

export function writeFeishuPair(record) {
  mkdirSync(dirname(feishuPairPath()), { recursive: true });
  writeFileSync(feishuPairPath(), JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
}

export function readFeishuPair(now = Date.now()) {
  try {
    const record = JSON.parse(readFileSync(feishuPairPath(), "utf8"));
    if (!record?.deviceCode || Number(record.exp) <= now) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

// Only the scan that owns the file may remove it; a newer one stays.
export function clearFeishuPair(id) {
  try {
    const record = JSON.parse(readFileSync(feishuPairPath(), "utf8"));
    if (record?.id === id) {
      unlinkSync(feishuPairPath());
    }
  } catch {
    /* already gone */
  }
}
