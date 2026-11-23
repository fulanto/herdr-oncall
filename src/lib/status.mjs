import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { channelList, feishuPaired, telegramPaired } from "./channels.mjs";
import { droverEnvPath, modeEnabled } from "./config.mjs";
import { panelState } from "./desktop.mjs";
import { herdrSocket, readOwner } from "./owner.mjs";
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

// The main session as `agent list` has it. Herdr not answering is reported as
// that, with the socket that was asked, not as "nobody has the name".
function mainAgentStatus(settings, run, session) {
  if (!rolesActive(settings)) {
    return { found: false };
  }
  const found = lookupAgentByName(settings.mainAgentName, run);
  if (found.found) {
    return { found: true, pane_id: found.paneId, agent: found.kind ?? null, status: found.status ?? null };
  }
  return {
    found: false,
    ...(found.error ? { error: found.error } : {}),
    ...(found.unreachable ? { unreachable: true, socket_path: session.path } : {}),
  };
}

function ownerStatus(owner, running, session) {
  if (!owner) {
    return { socket_path: null, running: null, current_session: false, since: null, via: null };
  }
  return {
    socket_path: owner.socket,
    running,
    current_session: owner.socket === session.path,
    since: owner.since ?? null,
    via: owner.via ?? null,
  };
}

function pollerStatus(alive, { pid, socket }, owner, session) {
  const bound = Boolean(socket);
  return {
    alive,
    pid: pid || null,
    socket_path: socket ?? null,
    bound_to_owner: bound && owner ? socket === owner.socket : null,
    current_session: bound ? socket === session.path : null,
  };
}

// `session` is the herdr server this call runs in, `owner` the record of the
// session Oncall belongs to, `ownerRunning` whether that one's server answers,
// and `poller` the running poller's { pid, socket }. "The poller is alive"
// said nothing while it was alive and bound to a herdr that no longer
// existed; these say which herdr Oncall serves, whether the poller is on it,
// and whether that is the session being asked from.
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
  session = herdrSocket(),
  owner = readOwner(),
  ownerRunning = null,
  poller = {},
  extra = {},
} = {}) {
  const settings = roleSettings(env);
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
    session: { socket_path: session.path, source: session.source },
    owner: ownerStatus(owner, ownerRunning, session),
    poller: pollerStatus(Boolean(pollerAlive()), poller, owner, session),
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
    main_agent: mainAgentStatus(settings, run, session),
    ...extra,
  };
}
