import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { configDirPath, pluginRoot, stateDir } from "./paths.mjs";

export const DEFAULT_NOTIFY_ON = "blocked,done";

export function seedConfigEnv() {
  const dir = configDirPath();
  mkdirSync(dir, { recursive: true });
  const src = join(pluginRoot, ".env.example");
  copyFileSync(src, join(dir, ".env.example"));
  const dest = join(dir, ".env");
  if (!existsSync(dest)) {
    copyFileSync(src, dest);
  }
  upgradeEnvNotifyOn(dest);
  return dest;
}

function upgradeEnvNotifyOn(envPath) {
  const original = readFileSync(envPath, "utf8");
  let content = original;
  if (!/^NOTIFY_ON=/m.test(content)) {
    content = `${content.replace(/\s*$/, "")}\nNOTIFY_ON=${DEFAULT_NOTIFY_ON}\n`;
  } else {
    content = content.replace(/^NOTIFY_ON=\s*blocked\s*$/im, `NOTIFY_ON=${DEFAULT_NOTIFY_ON}`);
  }
  if (!/^BLOCKED_DELAY_SEC=/m.test(content)) {
    content = `${content.replace(/\s*$/, "")}\nBLOCKED_DELAY_SEC=60\n`;
  }
  if (content !== original) {
    writeFileSync(envPath, content, "utf8");
  }
}

export function loadDotEnv(path) {
  const paths = path ? [path] : defaultDotEnvPaths();
  for (const candidate of paths) {
    loadDotEnvFile(candidate);
  }
}

function defaultDotEnvPaths() {
  const paths = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    paths.push(join(process.env.HERDR_PLUGIN_CONFIG_DIR, ".env"));
  }
  paths.push(join(pluginRoot, ".env"));
  return [...new Set(paths)];
}

function loadDotEnvFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = stripQuotes(value);
  }
}

export function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function modePath() {
  return join(stateDir(), "enabled");
}

export function modeEnabled() {
  const path = modePath();
  if (!existsSync(path)) {
    return envFlag("HERDR_TELEGRAM_ENABLED", true);
  }
  const raw = readFileSync(path, "utf8").trim().toLowerCase();
  return !["0", "false", "no", "off", "disabled"].includes(raw);
}

export function setMode(enabled) {
  const path = modePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, enabled ? "enabled\n" : "disabled\n", "utf8");
}

export function setWindowTitleIndicator(enabled) {
  if (!envFlag("HERDR_TELEGRAM_SET_TITLE", true)) {
    return;
  }
  const title = process.env.HERDR_TELEGRAM_TITLE || "oncall";
  const args = enabled
    ? ["terminal", "title", "set", title]
    : ["terminal", "title", "clear"];
  const bins = [...new Set([process.env.HERDR_BIN_PATH, "herdr"].filter(Boolean))];
  let lastError;
  for (const herdrBin of bins) {
    const result = spawnSync(herdrBin, args, { encoding: "utf8" });
    if (result.error) {
      lastError = result.error;
      continue;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      console.error(`title command exited ${result.status}${stderr ? `: ${stderr}` : ""}`);
      return;
    }
    return;
  }
  if (lastError) {
    console.error(`title command failed to start: ${lastError.message}`);
  }
}

export function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`invalid ${name}: ${error.message}`);
    return {};
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
