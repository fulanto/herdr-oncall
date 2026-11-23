import { appendPollerLog, pollHere, pollerBinding } from "../inbound/poller.mjs";
import { ownershipLines, seedConfigEnv } from "../lib/index.mjs";

// "Restart reply poller", and the one way Oncall moves: run in a herdr
// session, it makes that session the owner (src/lib/owner.mjs) and starts the
// poller on its herdr. Run where Oncall already is, it is only the restart,
// which is all the poller's own call after an update ever is, since the
// poller runs in the owner's session. A move is written to poller.log as well
// as here: Herdr's plugin log is short-lived, and "when did Oncall go to which
// session" is what someone will want to look up.
//
// Whoever runs this asked for the poller here, now. So it waits its turn if a
// poller is being started somewhere else, checks afterwards that the poller on
// record is the one it started, bound to this session's herdr, and exits 1
// saying so when it is not, rather than print a pid that is not its own.
function failed(reason) {
  console.error(`poll failed · ${reason}`);
  process.exit(1);
}

seedConfigEnv();
let done;
try {
  done = pollHere();
} catch (error) {
  failed(error?.message || String(error));
}
const { own, dropped, pid } = done;
for (const line of ownershipLines(own, dropped)) {
  console.log(line);
  appendPollerLog(line);
}
const bound = pollerBinding(pid);
if (bound?.socket !== own.socket) {
  failed(`the poller on record is not bound to this herdr (${own.socket}): ${bound ? bound.socket : "no binding for the pid just started"}`);
}
console.log(`poller pid ${pid} · herdr ${own.socket}`);
