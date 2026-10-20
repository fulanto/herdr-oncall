import { PLUGIN_ID } from "./paths.mjs";

const PANEL_HINTS = {
  ready: "panel: ready, blocked and done open a panel on this Mac",
  off: "panel: off (DESKTOP_PANEL=0 in .env)",
  unbuilt:
    "panel: not built, needs Xcode Command Line Tools (xcode-select --install), then reinstall the plugin",
};

function action(id, indent = "  ") {
  return `${indent}herdr plugin action invoke ${id} --plugin ${PLUGIN_ID}`;
}

// What `ensureIntegrations` did, for the setup output. An agent installed just
// now only reports sessions it starts from here on.
export function integrationLines({ installed = [], failed = [] } = {}) {
  return [
    ...installed.map(
      (agent) =>
        `${agent}: installed Herdr's ${agent} integration, so done pings carry its own answer (restart ${agent} sessions already running)`,
    ),
    ...failed.map(({ agent, detail }) => `${agent}: herdr integration install ${agent} failed: ${detail}`),
  ];
}

// Feishu replies arrive over a WebSocket, which Node only has built in from 22.
function nodeTooOld(websocket, nodeVersion) {
  return websocket ? undefined : `replies need Node 22 or later, this is ${nodeVersion}`;
}

function pairedLine(name, channels, oldNode) {
  const notes = [];
  if (!channels.includes(name)) {
    notes.push("CHANNEL does not include it");
  }
  if (name === "feishu" && oldNode) {
    notes.push(oldNode);
  }
  return notes.length ? `${name}: paired, but ${notes.join("; ")}` : `${name}: paired`;
}

// What setup prints after an install. The panel needs no configuration, so it
// comes first and the phone channels read as the optional remote leg they are.
// The old text asked every new user for a bot token and a chat id, which left
// someone who only wanted the panel unable to tell that it already worked.
// With nothing paired, the two channels are offered side by side, Feishu first:
// one scan sets it up, while Telegram needs a token from BotFather. Once one is
// paired, the other's setup is noise and is left out.
export function setupHints({
  panel,
  token,
  chatId,
  feishu = false,
  channels = ["telegram"],
  envPath,
  websocket = typeof globalThis.WebSocket === "function",
  nodeVersion = process.version,
  integrations = [],
}) {
  const lines = [];
  if (PANEL_HINTS[panel]) {
    lines.push(PANEL_HINTS[panel]);
  }
  const oldNode = nodeTooOld(websocket, nodeVersion);
  const telegram = Boolean(token && chatId);
  if (telegram) {
    lines.push(pairedLine("telegram", channels, oldNode));
  }
  if (feishu) {
    lines.push(pairedLine("feishu", channels, oldNode));
  }
  if (!telegram && !feishu) {
    const role = panel === "ready" ? "optional, for pings away from the desk" : "needed, nothing else can reach you here";
    lines.push(`remote (${role}), pick one:`);
    lines.push("  feishu: scan with the Feishu app, no token needed:", action("pair-feishu", "    "));
    // Without the panel, the QR code only exists in the action's output.
    lines.push(
      panel === "ready"
        ? "    (the QR opens in a panel on this Mac)"
        : `    (the QR is in: herdr plugin log list --plugin ${PLUGIN_ID} --limit 5)`,
    );
    if (oldNode) {
      lines.push(`    (${oldNode})`);
    }
    lines.push(
      token ? "  telegram: token set, chat not paired yet:" : `  telegram: put TELEGRAM_BOT_TOKEN in ${envPath}, then:`,
      action("pair", "    "),
    );
  }
  // `integrations` lists the agents still without the Herdr integration they
  // need — Codex, whose panes cannot otherwise be tied to a session. Oncall
  // installs it itself, so this only shows when that was turned off or failed.
  // Those done pings fall back to reading the answer off the screen.
  if (integrations.length) {
    lines.push("done pings: these agents need Herdr's integration to report their session:");
    for (const agent of integrations) {
      lines.push(`  herdr integration install ${agent}`);
    }
    lines.push("  (an agent already running picks it up once restarted)");
  }
  if (panel === "ready" || telegram || feishu) {
    lines.push("check it:", action("test"));
  }
  return lines;
}
