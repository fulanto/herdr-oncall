import { loadDotEnv, ownerOrExit, seedConfigEnv, unpairFeishu } from "../lib/index.mjs";
import { describeError, restartPoller } from "../inbound/poller.mjs";

// Forget the paired Feishu bot, so the next `pair-feishu` scans for a new one.
// `pair-feishu` itself never replaces a working pairing: every scan creates a
// bot in Feishu, and a second scan after a reinstall is how one machine ended
// up with two. The old bot stays in Feishu until someone deletes it there.

// Unpairing changes whom Oncall talks to: done from the session it belongs to.
ownerOrExit("refused · unpair-feishu");

loadDotEnv();
seedConfigEnv();

process.exit(await unpairFeishu({ restartPoller, describe: describeError }));
