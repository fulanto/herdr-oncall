// Preloaded (NODE_OPTIONS=--import) into a real-entry test's process: the
// network is off, as with no-network.mjs, and one answer is added. Telegram's
// sendMessage "sends" and returns a made-up message id, so an action that
// pings can be run for real without a bot. A test must not import this file:
// loading it is what replaces the network.
import "./no-network.mjs";

const FAKE_MESSAGE_ID = 501;
const off = globalThis.fetch;

globalThis.fetch = async (url, ...rest) => {
  if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/.test(String(url))) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: FAKE_MESSAGE_ID } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return off(url, ...rest);
};
