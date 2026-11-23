import {
  loadDotEnv,
  modeEnabled,
  modePath,
  ownerOrExit,
  setMode,
  setWindowTitleIndicator,
} from "../lib/index.mjs";

// The switch is the machine's one Oncall being on or off. A session it does
// not belong to (a test session, say) must not be able to silence it.
ownerOrExit(`refused · ${process.env.HERDR_PLUGIN_ACTION_ID || "toggle"}`);

loadDotEnv();

const requested = process.argv[2]?.trim().toLowerCase();
const enabled =
  requested === "on" || requested === "enable" || requested === "enabled"
    ? true
    : requested === "off" || requested === "disable" || requested === "disabled"
      ? false
      : !modeEnabled();

setMode(enabled);
setWindowTitleIndicator(enabled);

console.log(`Oncall ${enabled ? "enabled" : "disabled"}.`);
console.log(`State: ${modePath()}`);
