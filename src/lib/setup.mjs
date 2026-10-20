import { PLUGIN_ID } from "./paths.mjs";

const PANEL_HINTS = {
  ready: "panel: ready, blocked and done open a panel on this Mac",
  off: "panel: off (DESKTOP_PANEL=0 in .env)",
  unbuilt:
    "panel: not built, needs Xcode Command Line Tools (xcode-select --install), then reinstall the plugin",
};

function action(id) {
  return `  herdr plugin action invoke ${id} --plugin ${PLUGIN_ID}`;
}

// What setup prints after an install. The panel needs no configuration, so it
// comes first and Telegram reads as the optional remote channel it is. The old
// text asked every new user for a bot token and a chat id, which left someone
// who only wanted the panel unable to tell that it already worked.
export function setupHints({ panel, token, chatId, envPath }) {
  const lines = [];
  if (PANEL_HINTS[panel]) {
    lines.push(PANEL_HINTS[panel]);
  }
  const paired = Boolean(token && chatId);
  if (paired) {
    lines.push("telegram: paired");
  } else {
    if (token) {
      lines.push("telegram: token set, chat not paired yet:");
    } else {
      const role =
        panel === "ready" ? "optional, for pings away from the desk" : "needed, nothing else can reach you here";
      lines.push(`telegram: ${role}. Put TELEGRAM_BOT_TOKEN in ${envPath}, then:`);
    }
    lines.push(action("pair"));
  }
  if (panel === "ready" || paired) {
    lines.push("check it:", action("test"));
  }
  return lines;
}
