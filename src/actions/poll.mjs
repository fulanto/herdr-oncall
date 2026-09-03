import { restartPoller } from "../inbound/poller.mjs";
import { seedConfigEnv } from "../lib/index.mjs";

seedConfigEnv();
const pid = restartPoller();
console.log(`poller pid ${pid}`);
