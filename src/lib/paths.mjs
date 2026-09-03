import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = dirname(fileURLToPath(import.meta.url));
export const pluginRoot = process.env.HERDR_PLUGIN_ROOT || dirname(dirname(libDir));
export const PLUGIN_ID = "com.codreamer.herdr.oncall";
export const OLD_PLUGIN_IDS = ["oncall", "oncall.telegram", "fulanto.oncall"];

export function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function runHerdr(args) {
  return spawnSync(herdrBin(), args, { encoding: "utf8" });
}

export function configDirPath() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  const result = runHerdr(["plugin", "config-dir", PLUGIN_ID]);
  const printed = !result.error && result.status === 0 ? result.stdout.trim() : "";
  if (printed) {
    return printed;
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".config") : pluginRoot);
  return join(configHome, "herdr", "plugins", "config", PLUGIN_ID);
}

export function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  const stateHome =
    process.env.XDG_STATE_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".local", "state") : pluginRoot);
  return join(stateHome, "herdr-oncall");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
