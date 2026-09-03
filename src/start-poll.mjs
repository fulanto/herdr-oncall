import { restartPoller } from "./poller-ctl.mjs";
import { seedConfigEnv } from "./lib.mjs";

seedConfigEnv();
const pid = restartPoller();
console.log(`poller pid ${pid}`);
