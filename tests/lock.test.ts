import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, processStart } from '../src/lock.js';

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), 'audee-lock-')), 'audee.lock');

describe('single-instance lock', () => {
  it('TestSingleInstanceLock', () => {
    const path = lockPath();
    const release = acquireLock(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, started: processStart(process.pid) });
    expect(() => acquireLock(path)).toThrow(`audee is already running (pid ${process.pid})`);
    release();
    expect(existsSync(path)).toBe(false);
    const again = acquireLock(path);
    again();
  });

  it('TestLockReplacesDeadPid', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 999999, started: 'Mon Jan  1 00:00:00 2001' }));
    const release = acquireLock(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
    release();
  });

  it('TestLockReplacesReusedPid', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: process.pid, started: 'Mon Jan  1 00:00:00 2001' })); // live PID, different start time
    const release = acquireLock(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, started: processStart(process.pid) });
    release();
  });

  it('TestLockTreatsEpermAsStale', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 1, started: 'Mon Jan  1 00:00:00 2001' }));
    const release = acquireLock(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
    release();
    // a malformed lock file is stale too
    writeFileSync(path, 'garbage');
    acquireLock(path)();
    expect(existsSync(path)).toBe(false);
  });

  it('TestLockLeavesNoTempFiles', () => {
    const path = lockPath();
    writeFileSync(path, '');
    const release = acquireLock(path);
    expect(readdirSync(dirname(path))).toEqual(['audee.lock']);
    release();
    expect(readdirSync(dirname(path))).toEqual([]);
  });
});
