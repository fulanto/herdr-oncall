import { loadDotEnv, oncallStatus } from "../lib/index.mjs";
import { readEscalations } from "../inbound/escalation.mjs";
import { readInbox } from "../inbound/main-inbox.mjs";
import { pollerAlive } from "../inbound/poller.mjs";

// One line of JSON on stdout and nothing else, exit 0 whether or not anything
// is paired or switched on: drover runs this script directly
// (`/bin/bash <plugin_root>/bin/run-node.sh src/actions/status.mjs`) because
// `herdr plugin action invoke` returns before the output exists. Only a
// failure of the script itself exits non-zero, still with one line of JSON.
// It reads, never writes: no seeding, no poller, no network.
try {
  loadDotEnv();
  const status = oncallStatus({
    pollerAlive: () => pollerAlive(),
    extra: {
      pending: { escalations: Object.keys(readEscalations()).length, main_inbox: readInbox().length },
    },
  });
  process.stdout.write(`${JSON.stringify(status)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
}
