import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { channelList, feishuPaired, telegramPaired } from "./channels.mjs";
import { droverEnvPath, modeEnabled } from "./config.mjs";
import { panelState } from "./desktop.mjs";
import { pluginRoot, runHerdr } from "./paths.mjs";
import { lookupAgentByName, roleSettings, rolesActive } from "./roles.mjs";

// What drover's `drover oncall status` prints, read by running the status
// action's script directly. Every value is a fact about the setup; no secret
// ever goes in, not even shortened: tokens, secrets, open ids and chat ids are
// reported as paired or not.

export function manifestVersion(root = pluginRoot) {
  try {
    const text = readFileSync(join(root, "herdr-plugin.toml"), "utf8");
    return text.match(/^version\s*=\s*"([^"]*)"/m)?.[1];
  } catch {
    return undefined;
  }
}

export function oncallStatus({
  env = process.env,
  run = runHerdr,
  pollerAlive = () => false,
  version = manifestVersion(),
  panel = panelState(),
  enabled = modeEnabled(),
  droverEnv = droverEnvPath(),
  websocket = typeof globalThis.WebSocket === "function",
  nodeVersion = process.versions.node,
  extra = {},
} = {}) {
  const settings = roleSettings(env);
  let mainAgent = { found: false };
  if (rolesActive(settings)) {
    const found = lookupAgentByName(settings.mainAgentName, run);
    mainAgent = found.found
      ? { found: true, pane_id: found.paneId, agent: found.kind ?? null, status: found.status ?? null }
      : { found: false, ...(found.error ? { error: found.error } : {}) };
  }
  return {
    ok: true,
    version: version ?? null,
    enabled,
    channels: {
      selected: channelList(env.CHANNEL),
      feishu: { paired: feishuPaired(env), replies_supported: websocket },
      telegram: { paired: telegramPaired(env) },
    },
    node: { version: nodeVersion },
    poller: { alive: Boolean(pollerAlive()) },
    panel,
    drover_env: { present: existsSync(droverEnv), path: droverEnv },
    roles: {
      main_agent_name: settings.mainAgentName,
      supervisor_prefix: settings.supervisorPrefix,
      supervisor_escalate_sec: settings.supervisorEscalateSec,
      supervisor_escalate_sec_codex: settings.supervisorEscalateSecCodex,
      supervised_escalate_sec: settings.supervisedEscalateSec,
      bare_message_target: settings.bareMessageTarget,
      main_done_ping: settings.mainDonePing,
      main_relay_marker: settings.mainRelayMarker,
    },
    main_agent: mainAgent,
    ...extra,
  };
}
