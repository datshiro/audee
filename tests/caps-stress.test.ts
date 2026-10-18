import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { Job } from '../src/queue/job.js';
import { Queue, type RunOutcome } from '../src/queue/queue.js';
import { loadState } from '../src/state/state.js';
import { testConfig } from './helpers/test-config.js';

// Stress: 60 jobs over 20 people with random durations and random interrupt; the caps must never be exceeded.
it('TestCapsHoldUnderStress', async () => {
  const cfg = testConfig({ maxConcurrent: 3, heavy: 1, kb: 2, buffer: 64, maxInflight: 6, people: 20 });
  const state = loadState(cfg.data_dir);
  let total = 0;
  const byLane: Record<string, number> = { heavy: 0, kb: 0 };
  let maxTotal = 0;
  const maxLane: Record<string, number> = { heavy: 0, kb: 0 };
  let runs = 0;
  const run = async (j: Job, signal: AbortSignal): Promise<RunOutcome> => {
    const lane = j.kind === 'kb_query' ? 'kb' : 'heavy';
    total++;
    byLane[lane] = (byLane[lane] ?? 0) + 1;
    maxTotal = Math.max(maxTotal, total);
    maxLane[lane] = Math.max(maxLane[lane] ?? 0, byLane[lane] ?? 0);
    runs++;
    await sleep(1 + Math.floor(Math.random() * 8));
    total--;
    byLane[lane] = (byLane[lane] ?? 1) - 1;
    return signal.aborted ? 'interrupted' : 'done';
  };
  const q = new Queue(cfg, state, run);
  q.start();
  const kinds = ['review', 'code_mapping', 'kb_query'];
  let queued = 0;
  for (let i = 0; i < 60; i++) {
    const kind = kinds[i % 3] ?? 'kb_query';
    const principal = `teams:p${(i % 20) + 1}`;
    const j: Job = { kind, channel: 'teams', chatId: 'c', principal, requesterName: principal, requestedAt: new Date().toISOString(), ...(kind === 'review' ? { mrUrl: `https://gitlab.example.com/g/p/-/merge_requests/${i}` } : { messageId: `m${i}` }) };
    if (q.enqueue(j) === 'queued') queued++;
    if (i % 7 === 0) await sleep(2);
  }
  const deadline = Date.now() + 10_000;
  while (state.pendingJobs().length > 0 && Date.now() < deadline) await sleep(5);
  await q.stop();
  expect(state.pendingJobs()).toEqual([]);
  expect(runs).toBe(queued);
  expect(maxTotal).toBeLessThanOrEqual(3);
  expect(maxLane['heavy']).toBeLessThanOrEqual(1);
  expect(maxLane['kb']).toBeLessThanOrEqual(2);
  expect(maxTotal).toBe(3);
}, 30_000);
