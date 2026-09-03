import {
  loadDotEnv,
  modeEnabled,
  modePath,
  setMode,
  setWindowTitleIndicator,
} from "./lib.mjs";

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
