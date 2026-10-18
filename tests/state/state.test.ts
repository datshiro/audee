import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/queue/job.js';
import { reviewCooldownMs } from '../../src/queue/queue.js';
import { loadState, maxMessageRows, outcomeFailed, outcomeRetrying, outcomeSkipped } from '../../src/state/state.js';

const rawRetentionMs = 3 * 24 * 60 * 60 * 1000; // ciel/inbox.go:51
const tmp = (): string => mkdtempSync(join(tmpdir(), 'audee-state-'));
const MR = 'https://gitlab.example.com/g/p/-/merge_requests/1';
const review = (mrUrl: string, extra: Partial<Job> = {}): Job => ({ kind: 'review', channel: 'teams', chatId: 'chat', principal: 'teams:u', requesterName: 'U', mrUrl, requestedAt: new Date().toISOString(), ...extra });

describe('state', () => {
  // ciel/ciel_test.go:667 TestReviewerPersistsJobs, the state part
  it('TestReviewerPersistsJobs', () => {
    const dir = tmp();
    const state = loadState(dir);
    const job = review(MR);
    expect(state.startReview(MR, reviewCooldownMs)).toBe(true);
    state.addJob(job);
    expect(state.pendingJobs()).toEqual([job]);
    expect(readdirSync(dir)).toEqual(['state.json']); // the temp file was renamed away
    const reloaded = loadState(dir);
    expect(reloaded.pendingJobs()).toEqual([job]);
    reloaded.removeJob(job);
    expect(reloaded.pendingJobs()).toEqual([]);
    expect(loadState(dir).pendingJobs()).toEqual([]);
    expect(reloaded.startReview(MR, reviewCooldownMs)).toBe(false);
    reloaded.forgetReview(MR);
    expect(reloaded.startReview(MR, reviewCooldownMs)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toMatchObject({ jobs: [], reviews: { [MR]: expect.any(String) } });
  });

  // ciel/ciel_test.go:1002
  it('TestFindRequest', () => {
    const state = loadState(tmp());
    const mr = 'https://gitlab.example.com/g/p/-/merge_requests/12';
    const t0 = new Date(Date.UTC(2026, 9, 9, 6, 10, 0));
    const at = (min: number): string => new Date(t0.getTime() + min * 60_000).toISOString();
    state.record('chat-a', '1', { principal: 'teams:kha', at: at(0), text: mr + ' review giúp em', mentionsMe: false }, 6);
    state.record('chat-a', '2', { principal: 'teams:me', at: at(1), text: 'Not reviewed ' + mr, mentionsMe: false }, 6);
    state.record('chat-b', '3', { principal: 'teams:me', at: at(2), text: 'wrong group ' + mr, mentionsMe: false }, 6);
    const fromHistory = state.findRequest(mr);
    expect(fromHistory).toMatchObject({ kind: 'review', chatId: 'chat-a', principal: 'teams:kha', mrUrl: mr });
    const recorded = review(mr, { chatId: 'chat-c', principal: 'teams:lan' });
    state.recordRequest(recorded);
    expect(state.findRequest(mr)).toEqual(recorded);
    expect(state.findRequest('https://gitlab.example.com/g/p/-/merge_requests/999')).toBeUndefined();
    expect(state.hasSeen('2')).toBe(true);
    expect(state.chatHistory('chat-a')).toHaveLength(2);
  });

  // ciel/ciel_test.go:1028
  it('TestPruneRequestsDropsOldInput', () => {
    const state = loadState(tmp());
    const now = Date.now();
    const rev = review(MR);
    const old: Job = { kind: 'code_mapping', channel: 'teams', chatId: 'chat', principal: 'teams:u', requesterName: 'U', messageId: '1000000000001', input: 'x', requestedAt: new Date(now - 4 * 24 * 3600_000).toISOString() };
    const recent: Job = { ...old, messageId: '1000000000002', input: 'y', requestedAt: new Date(now - 3600_000).toISOString() };
    for (const j of [rev, old, recent]) state.recordRequest(j);
    state.pruneRequests(new Date(now - rawRetentionMs));
    expect(state.findRequest('1000000000001')).toBeUndefined();
    expect(state.findRequest(MR)).toEqual(rev);
    expect(state.findRequest('1000000000002')).toEqual(recent);
  });

  // ciel/trail_test.go:81, the state part: retries fold into the open row, a later claim after it closed starts a new row
  it('TestTrailFoldsRetriesIntoOneRow', () => {
    const state = loadState(tmp());
    const attempt = (err: string): void => state.trackMessage('1.json', (r) => { r.attempts++; r.outcome = outcomeRetrying; r.lastError = err; });
    attempt('claude exited: exit status 1');
    attempt('claude exited: exit status 1');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ file: '1.json', outcome: outcomeRetrying, attempts: 2, lastError: 'claude exited: exit status 1' });
    state.trackMessage('1.json', (r) => { r.attempts++; r.outcome = outcomeFailed; r.reason = 'gave up after 30m0s'; });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ outcome: outcomeFailed, attempts: 3 });
    state.trackMessage('1.json', (r) => { r.outcome = outcomeSkipped; });
    expect(state.messages).toHaveLength(2);
    state.trackMessage('', (r) => { r.outcome = outcomeSkipped; });
    expect(state.messages).toHaveLength(2);
  });

  // ciel/trail_test.go:115
  it('TestTrailKeepsNewestRows', () => {
    const state = loadState(tmp());
    for (let i = 0; i < maxMessageRows + 5; i++) state.trackMessage(`${i}.json`, (r) => { r.outcome = outcomeSkipped; });
    expect(state.messages).toHaveLength(maxMessageRows);
    expect(state.messages[0]?.file).toBe('5.json');
  });
});
