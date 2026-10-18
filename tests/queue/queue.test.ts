import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/queue/job.js';
import { Queue, type RunOutcome } from '../../src/queue/queue.js';
import { loadState } from '../../src/state/state.js';
import { testConfig } from '../helpers/test-config.js';

const job = (kind: string, key: string, principal = 'teams:p1'): Job => ({
  kind, channel: 'teams', chatId: 'chat', principal, requesterName: principal,
  ...(kind === 'review' ? { mrUrl: `https://gitlab.example.com/g/p/-/merge_requests/${key}` } : { messageId: key }),
  requestedAt: new Date().toISOString(),
});

// A fake runner: resolves 'done' when the test releases the job, or 'interrupted' when its signal aborts.
function fakeRunner() {
  const releases = new Map<string, () => void>();
  let running = 0;
  let maxRunning = 0;
  const runningByLane: Record<string, number> = {};
  const maxByLane: Record<string, number> = {};
  const run = (j: Job, signal: AbortSignal): Promise<RunOutcome> => new Promise((resolve) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    const lane = j.kind === 'kb_query' ? 'kb' : 'heavy';
    runningByLane[lane] = (runningByLane[lane] ?? 0) + 1;
    maxByLane[lane] = Math.max(maxByLane[lane] ?? 0, runningByLane[lane] ?? 0);
    const finish = (outcome: RunOutcome): void => {
      running--;
      runningByLane[lane] = (runningByLane[lane] ?? 1) - 1;
      releases.delete(j.messageId ?? j.mrUrl ?? '');
      resolve(outcome);
    };
    releases.set(j.messageId ?? j.mrUrl ?? '', () => finish('done'));
    signal.addEventListener('abort', () => finish('interrupted'), { once: true });
  });
  const release = (key: string): void => { releases.get(key)?.(); };
  const releaseAll = (): void => { for (const r of [...releases.values()]) r(); };
  return { run, release, releaseAll, get running() { return running; }, get maxRunning() { return maxRunning; }, maxByLane, get pending() { return releases.size; } };
}

const tick = (): Promise<void> => sleep(5);

describe('queue', () => {
  it('TestQueueCapRespected', async () => {
    const cfg = testConfig({ maxConcurrent: 2, heavy: 2, kb: 2, maxInflight: 10 });
    const fake = fakeRunner();
    const q = new Queue(cfg, loadState(cfg.data_dir), fake.run);
    q.start();
    for (let i = 1; i <= 5; i++) expect(q.enqueue(job(i % 2 ? 'review' : 'kb_query', String(i)))).toBe('queued');
    await tick();
    expect(fake.running).toBe(2);
    while (fake.pending > 0) { fake.releaseAll(); await tick(); }
    expect(fake.maxRunning).toBe(2);
    await q.stop();
  });

  it('TestLaneConcurrency', async () => {
    const cfg = testConfig({ maxConcurrent: 3, heavy: 1, kb: 2, maxInflight: 10 });
    const fake = fakeRunner();
    const q = new Queue(cfg, loadState(cfg.data_dir), fake.run);
    q.start();
    for (let i = 1; i <= 3; i++) q.enqueue(job('review', String(i)));
    await tick();
    expect(fake.running).toBe(1);
    while (fake.pending > 0) { fake.releaseAll(); await tick(); }
    expect(fake.maxByLane['heavy']).toBe(1);
    await q.stop();
  });

  it('TestQueueFullReply', async () => {
    const cfg = testConfig({ buffer: 2, heavy: 1, maxInflight: 10 });
    const state = loadState(cfg.data_dir);
    const fake = fakeRunner();
    const q = new Queue(cfg, state, fake.run);
    q.start();
    expect(q.enqueue(job('review', '1'))).toBe('queued'); // starts running
    await tick();
    expect(q.enqueue(job('review', '2'))).toBe('queued');
    expect(q.enqueue(job('review', '3'))).toBe('queued');
    expect(q.enqueue(job('review', '4'))).toBe('busy');
    expect(state.pendingJobs().map((j) => j.mrUrl)).not.toContain(job('review', '4').mrUrl);
    expect(state.startReview(job('review', '4').mrUrl ?? '', 30 * 60_000)).toBe(true); // the cooldown was lifted
    await q.stop();
  });

  it('TestQueueResumeAfterRestart', async () => {
    const cfg = testConfig({ heavy: 1, maxInflight: 10 });
    const state = loadState(cfg.data_dir);
    const fake = fakeRunner();
    const q = new Queue(cfg, state, fake.run);
    q.start();
    q.enqueue(job('review', '1'));
    q.enqueue(job('review', '2'));
    await tick();
    expect(fake.running).toBe(1);
    await q.stop();
    expect(fake.running).toBe(0);
    const reloaded = loadState(cfg.data_dir);
    expect(reloaded.pendingJobs().map((j) => j.mrUrl)).toEqual([job('review', '1').mrUrl, job('review', '2').mrUrl]);
    const fake2 = fakeRunner();
    const q2 = new Queue(cfg, reloaded, fake2.run);
    q2.start();
    await tick();
    expect(fake2.running).toBe(1);
    while (fake2.pending > 0 || reloaded.pendingJobs().length > 0) { fake2.releaseAll(); await tick(); }
    expect(reloaded.pendingJobs()).toEqual([]);
    expect(loadState(cfg.data_dir).pendingJobs()).toEqual([]);
    await q2.stop();
  });

  it('TestPerRequesterInflight', () => {
    const cfg = testConfig({ kbPerPersonLimit: 1, maxInflight: 10 });
    const q = new Queue(cfg, loadState(cfg.data_dir), fakeRunner().run); // not started: everything stays queued
    expect(q.enqueue(job('kb_query', '1', 'teams:p1'))).toBe('queued');
    expect(q.enqueue(job('kb_query', '2', 'teams:p1'))).toBe('limit');
    expect(q.enqueue(job('kb_query', '3', 'teams:p2'))).toBe('queued');
    expect(q.enqueue(job('review', '4', 'teams:p1'))).toBe('queued'); // another kind is not limited
  });

  it('TestPersonMaxInflight', () => {
    const cfg = testConfig({ maxInflight: 2 });
    const q = new Queue(cfg, loadState(cfg.data_dir), fakeRunner().run);
    expect(q.enqueue(job('review', '1', 'teams:p1'))).toBe('queued');
    expect(q.enqueue(job('kb_query', '2', 'teams:p1'))).toBe('queued');
    expect(q.enqueue(job('code_mapping', '3', 'teams:p1'))).toBe('limit');
    expect(q.enqueue(job('code_mapping', '4', 'teams:p2'))).toBe('queued');
  });

  it('TestDuplicateKeyIsSilent', () => {
    const cfg = testConfig({ maxInflight: 10 });
    const q = new Queue(cfg, loadState(cfg.data_dir), fakeRunner().run);
    expect(q.enqueue(job('kb_query', '1'))).toBe('queued');
    expect(q.enqueue(job('kb_query', '1'))).toBe('duplicate');
    expect(q.enqueue(job('review', '1'))).toBe('queued');
    expect(q.enqueue(job('review', '1'))).toBe('duplicate');
  });

  it('TestPerMRCooldown30m', async () => {
    const cfg = testConfig({ maxInflight: 10 });
    const state = loadState(cfg.data_dir);
    let now = new Date('2026-10-17T10:00:00Z');
    const fake = fakeRunner();
    const q = new Queue(cfg, state, fake.run, () => now);
    q.start();
    expect(q.enqueue(job('review', '1'))).toBe('queued');
    await tick();
    fake.releaseAll();
    await tick();
    expect(state.pendingJobs()).toEqual([]);
    now = new Date('2026-10-17T10:29:00Z');
    expect(q.enqueue(job('review', '1'))).toBe('cooldown');
    expect(q.enqueue(job('review', '1'), { ignoreCooldown: true })).toBe('queued');
    await tick();
    fake.releaseAll();
    await tick();
    now = new Date('2026-10-17T11:00:00Z');
    expect(q.enqueue(job('review', '1'))).toBe('queued');
    await q.stop();
  });

  it('TestLanesDoNotStarve', async () => {
    const cfg = testConfig({ maxConcurrent: 3, heavy: 1, kb: 2, maxInflight: 10 });
    const fake = fakeRunner();
    const q = new Queue(cfg, loadState(cfg.data_dir), fake.run);
    q.start();
    for (let i = 1; i <= 5; i++) q.enqueue(job('review', String(i)));
    await tick();
    expect(fake.running).toBe(1);
    expect(q.enqueue(job('kb_query', '10'))).toBe('queued');
    await tick();
    expect(fake.running).toBe(2);
    expect(fake.maxByLane['kb']).toBe(1);
    await q.stop();
  });

  it('TestQueueStartDropsUnconfiguredKind', async () => {
    const cfg = testConfig({});
    const state = loadState(cfg.data_dir);
    state.addJob(job('retired_capability', '1791513774214'));
    const runner = fakeRunner();
    const q = new Queue(cfg, state, runner.run);
    expect(() => q.start()).not.toThrow();
    expect(state.pendingJobs()).toEqual([]);
    await q.stop();
  });
});
