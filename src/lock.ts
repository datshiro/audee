// Single-instance lock: a file holding { pid, started }. Node has no flock, so liveness is the PID plus its
// start time (a reused PID has a different one).
import { execFileSync } from 'node:child_process';
import { linkSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';

export type LockRecord = { pid: number; started: string };

export type LockDeps = {
  pid?: number;
  startOf?: (pid: number) => string | undefined; // `ps -o lstart= -p <pid>`, trimmed; undefined when ps fails
  alive?: (pid: number) => boolean; // process.kill(pid, 0); EPERM counts as not ours, so stale
};

export function processStart(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: dead; EPERM: someone else's process, so not an audee of ours
  }
}

function readRecord(path: string): LockRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    if (typeof raw.pid === 'number' && typeof raw.started === 'string') return { pid: raw.pid, started: raw.started };
  } catch {
    // unreadable or malformed: stale
  }
  return undefined;
}

export function acquireLock(path: string, deps: LockDeps = {}): () => void {
  const pid = deps.pid ?? process.pid;
  const startOf = deps.startOf ?? processStart;
  const alive = deps.alive ?? signalable;
  const mine: LockRecord = { pid, started: startOf(pid) ?? '' };
  const alreadyRunning = (other: number): Error => new Error(`audee is already running (pid ${other})`);

  // The record is written first and linked into place, so the lock file never exists without it.
  const create = (): boolean => {
    const tmp = `${path}.${pid}`;
    writeFileSync(tmp, JSON.stringify(mine), { mode: 0o600 });
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return false;
    } finally {
      rmSync(tmp, { force: true });
    }
  };

  if (!create()) {
    const existing = readRecord(path);
    if (existing !== undefined && existing.pid !== pid && alive(existing.pid) && startOf(existing.pid) === existing.started) throw alreadyRunning(existing.pid);
    if (existing !== undefined && existing.pid === pid && existing.started === mine.started) throw alreadyRunning(existing.pid);
    // Stale: move it aside, and give it back if another starter replaced it meanwhile.
    const aside = `${path}.stale.${pid}`;
    try {
      renameSync(path, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const moved = readRecord(aside);
    if (moved !== undefined && (moved.pid !== existing?.pid || moved.started !== existing.started)) {
      try {
        linkSync(aside, path);
      } catch {
        // the winner's lock is back in place, or a third starter holds it
      }
      rmSync(aside, { force: true });
      throw alreadyRunning(moved.pid);
    }
    rmSync(aside, { force: true });
    if (!create()) throw alreadyRunning(readRecord(path)?.pid ?? -1);
  }
  return () => {
    const current = readRecord(path);
    if (current !== undefined && current.pid === pid && current.started === mine.started) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
  };
}
