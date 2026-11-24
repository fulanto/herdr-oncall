import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.mjs";
import { PING_TTL_MS, sendRemote } from "./channels.mjs";
import { stateDir } from "./paths.mjs";

// A test ping (the `test` action) is a ping about no pane. It used to be sent
// and forgotten, so a reply under it was a reply to nothing Oncall knew: it
// went the way of a message that names no ping, into the pane of the last real
// ping, and answered that pane's dialog when one was up. So every test ping is
// written down, message id → when it went out, for as long as any ping is
// (PING_TTL_MS), and the inbound side asks here before it looks for a pane
// (`aboutTestPing` in inbound/reply.mjs).
//
// The record is its own file, not part of outbound.json: every reader of that
// one counts on a record naming a pane, and it is dropped when Oncall moves to
// another herdr session, while a test ping is a test ping in any session.

function testPingsPath() {
  return join(stateDir(), "test-pings.json");
}

function liveTestPings(now) {
  let store;
  try {
    store = JSON.parse(readFileSync(testPingsPath(), "utf8"));
  } catch {
    store = {};
  }
  return Object.fromEntries(Object.entries(store ?? {}).filter(([, at]) => Number(at) && now - Number(at) < PING_TTL_MS));
}

export function rememberTestPing(messageId, now = Date.now()) {
  if (messageId === undefined || messageId === null) {
    return;
  }
  // The poller reads this while the action writes it: whole or not at all.
  writeFileAtomic(testPingsPath(), JSON.stringify({ ...liveTestPings(now), [String(messageId)]: now }));
}

export function isTestPing(messageId, now = Date.now()) {
  return messageId !== undefined && messageId !== null && Object.hasOwn(liveTestPings(now), String(messageId));
}

// When the most recent test ping went out; 0 with none on record.
export function lastTestPingAt(now = Date.now()) {
  return Math.max(0, ...Object.values(liveTestPings(now)).map(Number));
}

// The `test` action's pings: one on every channel given, each on its own, so
// one channel being down does not cost the other its ping, and each one that
// went out on record. Returns how many failed. `now` is when they count as
// sent, for a test; left out, it is the moment each is written down.
export async function sendTestPings(channels, text, { send = sendRemote, log = console.log, error = console.error, now } = {}) {
  let failed = 0;
  for (const channel of channels) {
    try {
      rememberTestPing(await send(channel, text, { status: "test" }), now);
      log(`sent test ping · ${channel}`);
    } catch (err) {
      failed++;
      error(`${channel} test ping failed: ${err?.message || err}`);
    }
  }
  return failed;
}
