// Single-instance lock: a file holding { pid, started }. Node has no flock, so liveness is the PID plus its
// start time (a reused PID has a different one).
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';

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
  const record = JSON.stringify(mine);
  const alreadyRunning = (other: number): Error => new Error(`audee is already running (pid ${other})`);

  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (fd !== undefined) {
    writeSync(fd, record);
    closeSync(fd);
  } else {
    const existing = readRecord(path);
    if (existing !== undefined && existing.pid !== pid && alive(existing.pid) && startOf(existing.pid) === existing.started) throw alreadyRunning(existing.pid);
    if (existing !== undefined && existing.pid === pid && existing.started === mine.started) throw alreadyRunning(existing.pid);
    // Stale: replace atomically, then confirm we won.
    const tmp = `${path}.${pid}`;
    writeFileSync(tmp, record, { mode: 0o600 });
    renameSync(tmp, path);
    const now = readRecord(path);
    if (now === undefined || now.pid !== pid) throw alreadyRunning(now?.pid ?? -1);
  }
  return () => {
    const current = readRecord(path);
    if (current !== undefined && current.pid === pid) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
  };
}
