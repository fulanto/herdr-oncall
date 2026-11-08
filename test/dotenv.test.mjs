import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDotEnv, setDotEnvValue, startupEnv } from "../src/lib/index.mjs";

const KEYS = ["HERDR_PLUGIN_CONFIG_DIR", "HERDR_BIN_PATH", "ONCALL_PROBE", "ONCALL_SHELL"];

function withEnv(body) {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "oncall-dotenv-"));
  try {
    body(dir);
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Stands in for the herdr binary, answering `plugin config-dir <id>` the way the
// real one does.
function fakeHerdr(dir) {
  const path = join(dir, "herdr");
  writeFileSync(path, `#!/bin/sh\n[ "$1" = "plugin" ] && [ "$2" = "config-dir" ] && echo '${dir}'\n`);
  chmodSync(path, 0o755);
  return path;
}

test("a shell-started process finds the .env by asking herdr", () => {
  withEnv((dir) => {
    writeFileSync(join(dir, ".env"), "ONCALL_PROBE=from-the-config-dir\n", "utf8");
    // Herdr sets HERDR_PLUGIN_CONFIG_DIR for events and actions and for nothing
    // else. Resolving the config directory from that variable alone is what
    // left the poller install.sh spawns with no token and no way to say so.
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.ONCALL_PROBE;
    process.env.HERDR_BIN_PATH = fakeHerdr(dir);
    loadDotEnv();
    assert.equal(process.env.ONCALL_PROBE, "from-the-config-dir");
  });
});

test("the directory Herdr hands over still wins outright", () => {
  withEnv((dir) => {
    writeFileSync(join(dir, ".env"), "ONCALL_PROBE=from-the-given-dir\n", "utf8");
    delete process.env.ONCALL_PROBE;
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    // No fake binary: resolving must not need one when the variable is there.
    process.env.HERDR_BIN_PATH = join(dir, "does-not-exist");
    loadDotEnv();
    assert.equal(process.env.ONCALL_PROBE, "from-the-given-dir");
  });
});

test("a value already in the environment is never overwritten", () => {
  withEnv((dir) => {
    const path = join(dir, "other.env");
    writeFileSync(path, "ONCALL_PROBE=from-the-file\n", "utf8");
    process.env.ONCALL_PROBE = "already here";
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "already here");
  });
});

test("a missing .env is not an error", () => {
  withEnv((dir) => {
    delete process.env.ONCALL_PROBE;
    loadDotEnv(join(dir, "nothing-here.env"));
    assert.equal(process.env.ONCALL_PROBE, undefined);
  });
});

// The poller loads the .env on every pass. A fresh install's file says
// `TELEGRAM_BOT_TOKEN=`, and the token the user fills in afterwards has to
// reach a process that already read the empty one.
test("a value read from the file follows the file when it changes", () => {
  withEnv((dir) => {
    const path = join(dir, "live.env");
    delete process.env.ONCALL_PROBE;
    writeFileSync(path, "ONCALL_PROBE=\n", "utf8");
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "");
    writeFileSync(path, "ONCALL_PROBE=123:abc\n", "utf8");
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "123:abc");
    writeFileSync(path, "# the line is gone\n", "utf8");
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, undefined);
  });
});

test("the environment still wins when the file changes underneath it", () => {
  withEnv((dir) => {
    const path = join(dir, "live.env");
    process.env.ONCALL_PROBE = "from the shell";
    writeFileSync(path, "ONCALL_PROBE=one\n", "utf8");
    loadDotEnv(path);
    writeFileSync(path, "ONCALL_PROBE=two\n", "utf8");
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "from the shell");
    writeFileSync(path, "\n", "utf8");
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "from the shell");
  });
});

test("a value changed by hand after the load is not the file's any more", () => {
  withEnv((dir) => {
    const path = join(dir, "live.env");
    delete process.env.ONCALL_PROBE;
    writeFileSync(path, "ONCALL_PROBE=one\n", "utf8");
    loadDotEnv(path);
    process.env.ONCALL_PROBE = "set by hand";
    writeFileSync(path, "ONCALL_PROBE=two\n", "utf8");
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "set by hand");
  });
});

test("a value written back to the file, as pairing does, keeps following it", () => {
  withEnv((dir) => {
    const path = join(dir, "live.env");
    delete process.env.ONCALL_PROBE;
    writeFileSync(path, "ONCALL_PROBE=42\n", "utf8");
    setDotEnvValue("ONCALL_PROBE", "42", path);
    writeFileSync(path, "ONCALL_PROBE=43\n", "utf8");
    loadDotEnv(path);
    assert.equal(process.env.ONCALL_PROBE, "43");
  });
});

// The poller is spawned by a hook that has already loaded the .env. Handed
// those values, the poller would take them for its own environment, which a
// file never overrides, and the refresh above would never happen.
test("a child is handed what this process started with, not what it read", () => {
  withEnv((dir) => {
    const path = join(dir, "live.env");
    delete process.env.ONCALL_PROBE;
    process.env.ONCALL_SHELL = "from the shell";
    writeFileSync(path, "ONCALL_PROBE=\nONCALL_SHELL=from-the-file\n", "utf8");
    loadDotEnv(path);
    const env = startupEnv();
    assert.equal("ONCALL_PROBE" in env, false);
    assert.equal(env.ONCALL_SHELL, "from the shell");
    assert.equal(process.env.ONCALL_PROBE, "");
  });
});

// ---------------------------------------------------------------------------
// drover.env: drover's settings, beside the user's .env in the config dir and
// below everything else (contract section 3). Each case runs in a child with
// its own plugin root, so every layer is a temp file and the order is the one
// a real hook sees: environment > config .env > plugin .env > drover.env.

const CONFIG_MODULE = new URL("../src/lib/config.mjs", import.meta.url).href;

function layered({ started = {}, configEnv, pluginEnv, droverEnv, rewrite, keys }) {
  const root = mkdtempSync(join(tmpdir(), "oncall-layers-"));
  const config = join(root, "config");
  const plugin = join(root, "plugin");
  mkdirSync(config);
  mkdirSync(plugin);
  const write = (path, text) => text !== undefined && writeFileSync(path, text, "utf8");
  write(join(config, ".env"), configEnv);
  write(join(plugin, ".env"), pluginEnv);
  write(join(config, "drover.env"), droverEnv);
  const script = [
    `import { writeFileSync } from "node:fs";`,
    `import { loadDotEnv } from ${JSON.stringify(CONFIG_MODULE)};`,
    `const keys = ${JSON.stringify(keys)};`,
    `const pick = () => Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));`,
    `loadDotEnv();`,
    `const first = pick();`,
    `const rewrite = ${JSON.stringify(rewrite ?? null)};`,
    `if (rewrite) { writeFileSync(${JSON.stringify(join(config, "drover.env"))}, rewrite, "utf8"); loadDotEnv(); }`,
    `console.log(JSON.stringify({ first, after: pick() }));`,
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_PLUGIN_ROOT: plugin,
        HERDR_BIN_PATH: join(root, "no-herdr"),
        ...started,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("drover.env is the lowest layer: the environment and both .env files beat it", () => {
  const { first } = layered({
    started: { A_KEY: "from the environment" },
    configEnv: "A_KEY=config\nB_KEY=config\n",
    pluginEnv: "B_KEY=plugin\nC_KEY=plugin\n",
    droverEnv: "A_KEY=drover\nB_KEY=drover\nC_KEY=drover\nD_KEY=drover\n",
    keys: ["A_KEY", "B_KEY", "C_KEY", "D_KEY"],
  });
  assert.deepEqual(first, { A_KEY: "from the environment", B_KEY: "config", C_KEY: "plugin", D_KEY: "drover" });
});

test("an empty value above drover.env does not count as set, and an empty drover value sets nothing", () => {
  const { first } = layered({
    // The user's .env is seeded from .env.example, where keys read `KEY=`.
    started: { E_KEY: "" },
    configEnv: "MAIN_AGENT_NAME=\nF_KEY=\n",
    pluginEnv: "G_KEY=\n",
    droverEnv: "MAIN_AGENT_NAME=drover\nE_KEY=drover\nG_KEY=drover\nH_KEY=\n",
    keys: ["MAIN_AGENT_NAME", "E_KEY", "F_KEY", "G_KEY", "H_KEY"],
  });
  assert.deepEqual(first, { MAIN_AGENT_NAME: "drover", E_KEY: "drover", F_KEY: "", G_KEY: "drover", H_KEY: null });
});

test("between the two .env files an empty value still wins, as it did before drover.env", () => {
  const { first } = layered({
    configEnv: "TELEGRAM_BOT_TOKEN=\n",
    pluginEnv: "TELEGRAM_BOT_TOKEN=from-the-plugin-dir\n",
    keys: ["TELEGRAM_BOT_TOKEN"],
  });
  assert.deepEqual(first, { TELEGRAM_BOT_TOKEN: "" });
});

test("a rewritten drover.env reaches a process that already read it, without a restart", () => {
  const changed = layered({
    configEnv: "SUPERVISED_ESCALATE_SEC=\n",
    droverEnv: "MAIN_AGENT_NAME=drover\nSUPERVISED_ESCALATE_SEC=600\n",
    rewrite: "SUPERVISED_ESCALATE_SEC=60\n",
    keys: ["MAIN_AGENT_NAME", "SUPERVISED_ESCALATE_SEC"],
  });
  assert.deepEqual(changed.first, { MAIN_AGENT_NAME: "drover", SUPERVISED_ESCALATE_SEC: "600" });
  // A key the rewrite dropped takes its value with it; a changed one follows.
  assert.deepEqual(changed.after, { MAIN_AGENT_NAME: null, SUPERVISED_ESCALATE_SEC: "60" });

  // drover uninstalled: its values go, the user's empty line stays.
  const removed = layered({
    configEnv: "SUPERVISED_ESCALATE_SEC=\n",
    droverEnv: "MAIN_AGENT_NAME=drover\nSUPERVISED_ESCALATE_SEC=600\n",
    rewrite: "# removed by install.py --uninstall\n",
    keys: ["MAIN_AGENT_NAME", "SUPERVISED_ESCALATE_SEC"],
  });
  assert.deepEqual(removed.after, { MAIN_AGENT_NAME: null, SUPERVISED_ESCALATE_SEC: "" });
});
