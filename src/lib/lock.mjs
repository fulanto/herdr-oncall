import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

// A lock file: created with `wx`, so one process gets it, with the holder's
// pid inside. One whose holder is gone, or that is older than `staleMs` (no
// holder keeps it that long), is abandoned and taken over. Two processes use
// these: the poller and send-main share the main session's inbox, and every
// hook process may find the poller needs starting.

function create(path) {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    return false;
  }
}

// Which file this is, so that one put in its place later is not taken for it.
// The inode alone will not do: a file created right after another was removed
// can get the same number.
function identity(path) {
  const pid = Number(readFileSync(path, "utf8").trim());
  const stat = statSync(path);
  return { pid, age: Date.now() - stat.mtimeMs, mark: `${stat.ino}:${stat.mtimeMs}:${pid}` };
}

// The lock's identity when it has been abandoned, nothing while it is held
// (or was released as we looked: the next try takes it).
function abandoned(path, staleMs) {
  let lock;
  try {
    lock = identity(path);
  } catch {
    return undefined;
  }
  if (lock.age > staleMs) {
    return lock.mark;
  }
  if (!(lock.pid > 1)) {
    // Created a moment ago, its pid not written yet.
    return undefined;
  }
  try {
    process.kill(lock.pid, 0);
    return undefined;
  } catch (error) {
    return error?.code === "ESRCH" ? lock.mark : undefined;
  }
}

// Takes the abandoned lock out of the way. Two processes can both find it
// abandoned, and "remove it, then create mine" let the second one remove the
// first one's new lock, after which both held it. Renaming the file aside is
// something only one of them can do to it; the other finds nothing to rename,
// or renames the first one's new lock, sees that it is not the file it judged,
// and puts it back.
function clearAbandoned(path, mark) {
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  let same = false;
  try {
    same = identity(aside).mark === mark;
    if (!same) {
      // A link, not a rename back: a lock created in this instant stays.
      linkSync(aside, path);
    }
  } catch {
    /* gone, or a newer lock is in place already */
  }
  rmSync(aside, { force: true });
  return same;
}

// Takes the lock if it is free or abandoned. Returns whether this process
// holds it now; never waits. `meanwhile` runs between finding the lock
// abandoned and taking it over, which is where another process can get in
// first; the tests play that process with it.
export function tryLock(path, { staleMs, meanwhile = () => {} }) {
  if (create(path)) {
    return true;
  }
  const mark = abandoned(path, staleMs);
  if (!mark) {
    return false;
  }
  meanwhile();
  return clearAbandoned(path, mark) && create(path);
}

export function unlock(path) {
  rmSync(path, { force: true });
}
