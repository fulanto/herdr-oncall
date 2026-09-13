import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = dirname(fileURLToPath(import.meta.url));
export const pluginRoot = process.env.HERDR_PLUGIN_ROOT || dirname(dirname(libDir));
export const PLUGIN_ID = "com.codreamer.herdr.oncall";
export const OLD_PLUGIN_IDS = ["oncall", "oncall.telegram", "fulanto.oncall"];

// Herdr names its own directories after the build it is: a release binary uses
// `herdr`, a debug one `herdr-dev`.
const HERDR_APP_DIRS = ["herdr", "herdr-dev"];

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

function stateHome() {
  if (process.env.XDG_STATE_HOME) {
    return process.env.XDG_STATE_HOME;
  }
  return process.env.HOME ? join(process.env.HOME, ".local", "state") : undefined;
}

// Where Herdr itself keeps this plugin's state: `<state home>/herdr/plugins/<id>`
// (src/plugin_paths.rs, plugin_state_dir). It only hands that path to us as
// HERDR_PLUGIN_STATE_DIR for events and actions — never for build commands, and
// never for anything you run from a shell, install.sh included.
export function managedStateDir() {
  const home = stateHome();
  if (!home) {
    return undefined;
  }
  return HERDR_APP_DIRS.map((app) => join(home, app, "plugins", PLUGIN_ID)).find((path) =>
    existsSync(path),
  );
}

// Computing Herdr's own path beats inventing a second one. When this fell back
// to `<state home>/herdr-oncall`, a shell-run process and a Herdr-run hook kept
// their state in different directories, so each side's `poller.pid` was
// invisible to the other and `ensurePoller()` could not tell that a poller was
// already up: five of them ended up long-polling the same bot token, and
// whichever one won an update had no `outbound.json` to resolve the pane with.
// The old path is still the fallback, for a machine where Herdr has never
// linked the plugin.
export function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  const managed = managedStateDir();
  if (managed) {
    return managed;
  }
  return join(stateHome() ?? pluginRoot, "herdr-oncall");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
