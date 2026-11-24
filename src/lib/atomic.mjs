import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Writing a file that another process may be reading.
//
// The state dir is shared by every hook, every action and the poller, each a
// process of its own. writeFileSync empties the file and then fills it, and a
// read that lands in between gets a file that is there and empty. Every reader
// takes that for "nothing on record": an empty poller.pid said that no poller
// was running (so a second one could be started, and `status` reported none),
// an empty store read as {} and was written back without anyone else's
// records. The pid file showed it first, because every start writes it twice:
// once by whoever started the poller, and again by the poller as it comes up.
//
// So a record is written whole into a file of its own beside the target and
// renamed over it. A rename puts the new file in place in one step: a reader
// gets the old record or the new one, never the moment between them.

// `data` in a file beside `path` that only this process writes; returns where
// it is. For a caller that puts it in place its own way (a hard link, which
// creates the target only when there is none).
export function tempFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data, "utf8");
  return temp;
}

export function writeFileAtomic(path, data) {
  renameSync(tempFile(path, data), path);
}
