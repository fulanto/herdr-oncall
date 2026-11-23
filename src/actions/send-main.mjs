import { loadDotEnv } from "../lib/index.mjs";
import { BOARD, sendFromBoard } from "../inbound/main-inbox.mjs";
import { appendPollerLog, ensurePoller } from "../inbound/poller.mjs";

// drover's task board → the main session. drover runs this script directly,
// from the plugin root, as it runs status.mjs:
//
//   /bin/bash <plugin_root>/bin/run-node.sh src/actions/send-main.mjs --source board --text "<文字>"
//
// `--text` is what the user clicked, without a prefix: it goes in as
// `[看板] <text>`, through the same delivery as a chat message (never into a
// dialog, never after a draft, never into a busy Codex: those wait in the
// inbox for the poller). It is not a Herdr action, since an action takes no
// arguments.
//
// stdout is exactly one line of JSON (see sendFromBoard); exit 0 when the text
// was delivered or queued, 1 otherwise, still with one line of JSON. The log
// lines go to poller.log, never to stdout and never with the text.
//
// Run in a herdr session that does not own Oncall, it types nothing and queues
// nothing: `{"ok":false,"error":…}`, exit 1 (sendFromBoard).

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag !== "--source" && flag !== "--text") {
      return { error: `不认识的参数 ${flag}` };
    }
    if (i + 1 >= argv.length) {
      return { error: `${flag} 后面缺值` };
    }
    args[flag.slice(2)] = argv[i + 1];
  }
  if (args.source !== BOARD) {
    return { error: `--source 只能是 ${BOARD}` };
  }
  if (args.text === undefined) {
    return { error: "缺 --text" };
  }
  return args;
}

let result;
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    result = { ok: false, error: args.error };
  } else {
    loadDotEnv();
    result = await sendFromBoard(args.text, { log: appendPollerLog });
  }
} catch (error) {
  result = { ok: false, error: String(error?.message || error) };
}
if (result.result === "queued") {
  // Only the poller sends what waits in the inbox. One that is not running
  // would leave the click there until the next notify event starts it.
  try {
    ensurePoller({ log: appendPollerLog });
  } catch (error) {
    appendPollerLog(`send-main · could not start the poller: ${error?.message || error}`);
  }
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
