import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePerson } from '../../src/authz/people.js';
import type { Capability } from '../../src/capability/types.js';
import { eventsPath } from '../../src/events.js';
import { setNotify } from '../../src/notify.js';
import type { Job } from '../../src/queue/job.js';
import { reviewCooldownMs } from '../../src/queue/queue.js';
import { busyText, deniedText, failedReply, iamTraceQueuedReply, iamTraceUsageReply, kbQueryEmptyReply, kbQueryPendingReply, kbQueryQueuedReply, mappingQueuedReply, pendingText, queuedReply, recentReply, replyHTML, unavailableText } from '../../src/render/html.js';
import { InterruptedError, type RunInput, type RunResult } from '../../src/runner/run.js';
import { loadState, outcomeFailed, outcomeSkipped } from '../../src/state/state.js';
import { giveUpAfterMs, Inbox, type InboxFile, parseInboxFile, trailReason } from '../../src/teams/inbox.js';
import type { ChatMessage } from '../../src/teams/message.js';
import { Outbox } from '../../src/teams/outbox.js';
import { ensureRerunDir, outcomeDenied, quietAlertDue, rerunDir, Watcher } from '../../src/teams/watcher.js';
import { testConfig, type TestConfigOptions } from '../helpers/test-config.js';

const CHAT = '19:chat@thread.v2';
const A = '19:group-a@thread.v2';
const B = '19:group-b@thread.v2';
const MR_PATTERN = 'https://gitlab\\.example\\.com/[^\\s"\'<>]+/-/merge_requests/\\d+';
const MR = 'https://gitlab.example.com/g/p/-/merge_requests/5';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'audee-watch-'));
const none = new AbortController().signal;

// ciel/ciel_test.go:306 inboxJSON and trail_test.go:28 messageJSON, with chat ids that pass the allowlist rule
const inboxJSON = (id: string, from: string, at: Date, content = `hello ${id}`, chatId = CHAT, messageType = 'message', displayName?: string): string =>
  JSON.stringify({ version: 1, chatId, meId: 'me-id', message: { id, messageType, createdDateTime: at.toISOString(), from: { user: { id: from, ...(displayName !== undefined ? { displayName } : {}) } }, body: { contentType: 'text', content } } });
const file = (json: string): InboxFile => { const f = parseInboxFile(json); f.name = `${f.message.id}.json`; return f; };
const msg = (from: string, html: string, id = '1', ...mentioned: string[]): ChatMessage => ({ id, messageType: 'message', createdDateTime: new Date().toISOString(), from: { user: { id: from } }, body: { contentType: 'html', content: html }, mentions: mentioned.map((m) => ({ mentioned: { user: { id: m } } })) });
const decision = (d: { addressed_to_me: boolean; intent: string; mr_urls?: string[]; summary?: string }): RunResult => ({ isError: false, text: '{}', structured: { mr_urls: [], summary: '', ...d }, denials: [], toolUses: [], durationMs: 1 });
const replies = (outbox: Outbox): Array<{ chatId: string; mentionUserId: string; html: string; file?: { name: string; content: string } }> => readdirSync(outbox.dir).map((n) => JSON.parse(readFileSync(join(outbox.dir, n), 'utf8')));
const saying = (outbox: Outbox, text: string): number => replies(outbox).filter((r) => r.html.includes(text)).length;
const events = (dataDir: string): Array<Record<string, unknown>> => (existsSync(eventsPath(dataDir)) ? readFileSync(eventsPath(dataDir), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>) : []);

type HarnessOptions = { result?: RunResult | Error; capabilities?: Partial<Record<'review' | 'mapping' | 'kb_read' | 'mcp_read' | 'iam_trace', Capability>> } & TestConfigOptions;

function harness(o: HarnessOptions = {}) {
  const { result, capabilities, ...cfgOpts } = o;
  const cfg = testConfig({ teams: { chats: [CHAT, A, B], aliases: ['Dat', 'anh Đạt'], mrUrlPattern: MR_PATTERN, historySize: 3, ...cfgOpts.teams }, peopleIds: ['a', 'colleague', 'linh', 'kha', 'u'], maxInflight: 10, ...cfgOpts });
  const state = loadState(cfg.data_dir);
  const outbox = new Outbox(tmp(), tmp());
  const inputs: RunInput[] = [];
  const run = async (input: RunInput): Promise<RunResult> => {
    inputs.push(input);
    if (result instanceof Error) throw result;
    return result ?? decision({ addressed_to_me: false, intent: 'other' });
  };
  const notes: string[] = [];
  setNotify((title, text) => { notes.push(`${title}: ${text}`); });
  const watcher = new Watcher({ cfg, state, source: { scan: async () => 0 }, outbox, run, secrets: {}, capabilities: capabilities ?? {} });
  return { cfg, state, outbox, watcher, inputs, notes };
}

describe('watcher', () => {
  afterEach(() => setNotify(() => {}));

  // ciel/ciel_test.go:438
  it('TestHandleDedupesAndKeepsHistory', async () => {
    const { watcher, state } = harness();
    const t0 = new Date(Date.UTC(2026, 9, 8, 10, 0, 0));
    for (const [i, id] of ['1', '2', '2', '3', '4', '5'].entries()) await watcher.handle(file(inboxJSON(id, 'a', new Date(t0.getTime() + i * 60_000))), none);
    expect(state.chatHistory(CHAT).map((e) => e.text)).toEqual(['hello 3', 'hello 4', 'hello 5']);
    const before = watcher.history(CHAT, { id: '6', createdDateTime: new Date(t0.getTime() + 4 * 60_000).toISOString(), body: {} });
    expect(before.map((m) => m.body.content)).toEqual(['hello 3']);
  });

  // ciel/ciel_test.go:469
  it('TestHistoryKeepsMentionOfMe', async () => {
    const { watcher } = harness();
    watcher.detector.meId = 'me-id';
    const m = msg('colleague', '<at>Dat</at> xem giúp', '1', 'me-id');
    watcher.record(CHAT, m);
    const h = watcher.history(CHAT, { id: '2', createdDateTime: new Date(Date.parse(m.createdDateTime ?? '') + 1000).toISOString(), body: {} });
    expect(h).toHaveLength(1);
    expect(watcher.detector.mentionsMe(h[0] ?? { id: '', body: {} })).toBe(true);
    expect(h[0]?.from?.user?.id).toBe('colleague');
  });

  // ciel/ciel_test.go:634
  it('TestHistoryStaysInTimeOrder', async () => {
    const { watcher, state } = harness();
    const t0 = new Date(Date.UTC(2026, 9, 8, 10, 0, 0));
    for (const id of ['3', '1', '2', '0']) await watcher.handle(file(inboxJSON(id, 'a', new Date(t0.getTime() + Number(id) * 60_000))), none);
    expect(state.chatHistory(CHAT).map((e) => e.text)).toEqual(['hello 1', 'hello 2', 'hello 3']);
  });

  // ciel/ciel_test.go:653
  it('TestHandleRetriesWhenClassifyFails', async () => {
    const { watcher, state } = harness({ result: new Error('session failed: Not logged in') });
    await expect(watcher.handle(file(inboxJSON('1', 'colleague', new Date(), 'anh Dat ơi')), none)).rejects.toThrow('classify message 1');
    expect(state.hasSeen('1')).toBe(false);
    expect(state.chatHistory(CHAT)).toEqual([]);
  });

  // ciel/kbquery_test.go:115
  it('TestHandleQueuesKBQueryWithoutClassifying', async () => {
    const { watcher, state, outbox, inputs } = harness({ result: new Error('must not classify') });
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'anh Dat kb_query past segment hoạt động thế nào?')), none);
    const jobs = state.pendingJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'kb_query', input: 'past segment hoạt động thế nào?', principal: 'teams:linh' });
    expect(replies(outbox)).toEqual([{ version: 1, chatId: CHAT, mentionUserId: 'linh', html: kbQueryQueuedReply }]);
    expect(state.hasSeen('1791513774214')).toBe(true);
    expect(inputs).toHaveLength(0);
  });

  // ciel/kbquery_test.go:135
  it('TestHandleKBQueryWithoutQuestion', async () => {
    const { watcher, state, outbox } = harness();
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat kb_query')), none);
    expect(state.pendingJobs()).toEqual([]);
    expect(replies(outbox).map((r) => r.html)).toEqual([kbQueryEmptyReply]);
  });

  it('TestHandleIamTraceQueues', async () => {
    const { watcher, state, outbox, inputs } = harness({ result: new Error('must not classify'), iamTrace: {} });
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'anh Dat iam_trace C1 u1,u2')), none);
    expect(state.pendingJobs()).toHaveLength(1);
    expect(state.pendingJobs()[0]).toMatchObject({ kind: 'iam_trace', input: 'C1 u1,u2', principal: 'teams:linh' });
    expect(watcher.queue.snapshot().find((l) => l.name === 'kb')?.queued).toEqual([expect.objectContaining({ kind: 'iam_trace' })]);
    expect(replies(outbox).map((r) => r.html)).toEqual([iamTraceQueuedReply]);
    expect(inputs).toHaveLength(0);
  });

  it('TestHandleIamTraceRenamedCapability', async () => {
    const { cfg, watcher, state, outbox } = harness({ iamTrace: {} });
    cfg.capabilities['trace_alias'] = cfg.capabilities['iam_trace']!;
    delete cfg.capabilities['iam_trace'];
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat iam_trace')), none);
    await watcher.handle(file(inboxJSON('1791513774215', 'linh', new Date(), 'anh Dat iam_trace C1 u1')), none);
    expect(state.pendingJobs()).toHaveLength(1);
    expect(state.pendingJobs()[0]).toMatchObject({ kind: 'trace_alias' });
    expect(replies(outbox).map((r) => r.html).sort()).toEqual([iamTraceUsageReply, iamTraceQueuedReply].sort());
  });

  it('TestHandleIamTraceNameOnAnotherProfile', async () => {
    const { cfg, watcher, outbox } = harness({ iamTrace: {} });
    const cap = cfg.capabilities['iam_trace']!;
    cap.profile = 'mcp_read';
    cap.trigger = 'iam_look';
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat iam_look')), none);
    expect(replies(outbox).map((r) => r.html)).not.toContain(iamTraceUsageReply);
  });

  it('TestHandleIamTraceWithoutArgs', async () => {
    const { watcher, state, outbox } = harness({ iamTrace: {} });
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat iam_trace')), none);
    expect(state.pendingJobs()).toEqual([]);
    expect(replies(outbox).map((r) => r.html)).toEqual([iamTraceUsageReply]);
  });

  it('TestHandleIamTraceDenied', async () => {
    const { watcher, state, outbox } = harness({ iamTrace: {}, grants: { linh: ['kb_query'] } });
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat iam_trace C1 u1')), none);
    expect(state.pendingJobs()).toEqual([]);
    expect(replies(outbox).map((r) => r.html)).toEqual([deniedText('iam_trace')]);
  });

  it('TestHandleIamTraceGrantedExplicitly', async () => {
    const { watcher, state } = harness({ iamTrace: {}, grants: { linh: ['iam_trace'] } });
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat iam_trace C1 u1')), none);
    expect(state.pendingJobs()).toEqual([expect.objectContaining({ kind: 'iam_trace', input: 'C1 u1' })]);
  });

  it('TestHandleIamTraceDisabled', async () => {
    const { watcher, state, outbox } = harness({ iamTrace: { enabled: false } });
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat iam_trace C1 u1')), none);
    expect(state.pendingJobs()).toEqual([]);
    expect(replies(outbox).map((r) => r.html)).toEqual([unavailableText('iam_trace')]);
  });

  // ciel/kbquery_test.go:456
  it('TestHandleKBQueryOnePendingPerRequester', async () => {
    const { watcher, state, outbox } = harness({ kbPerPersonLimit: 1 });
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat kb_query one?')), none);
    await watcher.handle(file(inboxJSON('1791513774215', 'linh', new Date(), 'Dat kb_query two?')), none);
    expect(state.pendingJobs().map((j) => j.input)).toEqual(['one?']);
    expect(saying(outbox, 'chưa xong')).toBe(1);
  });

  // ciel/ciel_test.go:816
  it('TestReviewReplyGoesToTheRequestingChat', async () => {
    const { watcher, state, outbox } = harness({ result: decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: [MR], summary: 'review MR' }) });
    for (const chat of [A, B]) {
      state.forgetReview(MR);
      await watcher.handle(file(inboxJSON('msg-' + chat, 'colleague', new Date(), 'anh Dat review giúp em ' + MR, chat)), none);
    }
    // One review per MR: the second chat is told it was asked recently (Ciel queued a second review)
    expect(state.pendingJobs().map((j) => j.chatId)).toEqual([A]);
    const got = replies(outbox);
    for (const r of got) expect(r.mentionUserId).toBe('colleague');
    expect(got.map((r) => [r.chatId, r.html.startsWith(queuedReply) ? 'queued' : r.html.startsWith(recentReply) ? 'recent' : 'other']).sort()).toEqual([[A, 'queued'], [B, 'recent']]);
  });

  // ciel/ciel_test.go:858
  it('TestCooldownSkipTellsRequester', async () => {
    const { watcher, outbox } = harness({ result: decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: [MR], summary: 'review MR' }) });
    for (const id of ['first', 'again']) await watcher.handle(file(inboxJSON(id, 'colleague', new Date(), 'anh Dat review giúp em ' + MR)), none);
    expect([saying(outbox, queuedReply), saying(outbox, recentReply), replies(outbox).length]).toEqual([1, 1, 2]);
  });

  // ciel/ciel_test.go:885
  it('TestOneReplyPerKindForSeveralMRs', async () => {
    const mr = 'https://gitlab.example.com/g/p/-/merge_requests/';
    const { watcher, state, outbox } = harness({ result: decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: [mr + '1', mr + '2', mr + '3'], summary: 'review MRs' }) });
    state.startReview(mr + '3', reviewCooldownMs);
    await watcher.handle(file(inboxJSON('m', 'colleague', new Date(), `anh Dat review giúp em ${mr}1 ${mr}2 ${mr}3`)), none);
    const got = replies(outbox).map((r) => r.html).sort();
    expect(got).toEqual([replyHTML(recentReply, mr + '3'), replyHTML(queuedReply, mr + '1', mr + '2')].sort());
  });

  // ciel/ciel_test.go:924, on the queue's buffer: the dropped review gets the busy text with its link
  it('TestFullQueueTellsRequester', async () => {
    const mr = 'https://gitlab.example.com/g/p/-/merge_requests/';
    const { watcher, state, outbox, notes } = harness({ buffer: 2, result: decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: [mr + '0', mr + '1', mr + '2'], summary: 'review MRs' }) });
    await watcher.handle(file(inboxJSON('m', 'u', new Date(), `anh Dat review ${mr}0 ${mr}1 ${mr}2`)), none);
    expect(state.pendingJobs().map((j) => j.mrUrl)).toEqual([mr + '0', mr + '1']);
    const busy = replies(outbox).filter((r) => r.html.includes(busyText()));
    expect(busy).toHaveLength(1);
    expect(busy[0]?.html).toContain(mr + '2<');
    expect(saying(outbox, queuedReply)).toBe(1);
    expect(notes.some((n) => n.includes('queue full'))).toBe(true);
  });

  // ciel/ciel_test.go:950
  it('TestFullQueueDropsMappingWithNotice', async () => {
    const { watcher, state, outbox, cfg } = harness({ buffer: 1, result: decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: [MR], summary: 'review' }) });
    await watcher.handle(file(inboxJSON('m', 'u', new Date(), 'anh Dat review ' + MR)), none);
    const person = resolvePerson(cfg, 'teams:u');
    if (person === undefined) throw new Error('no person');
    watcher.act(CHAT, msg('u', 'a|b', '1000000000001'), person, { addressedToMe: true, intent: 'code_mapping', mrUrls: [], summary: 'map' });
    expect(replies(outbox).map((r) => r.html).sort()).toEqual([replyHTML(queuedReply, MR), busyText()].sort());
    expect(state.pendingJobs()).toHaveLength(1);
  });

  // ciel/mapping_test.go:159
  it('TestActQueuesCodeMapping', () => {
    const { watcher, state, outbox, cfg } = harness();
    const person = resolvePerson(cfg, 'teams:linh');
    if (person === undefined) throw new Error('no person');
    const m = msg('linh', 'a|b<br>c', '1791513774214');
    expect(watcher.act(CHAT, m, person, { addressedToMe: true, intent: 'code_mapping', mrUrls: [], summary: 'map' })).toBe('code_mapping queued');
    const jobs = state.pendingJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'code_mapping', messageId: '1791513774214' });
    expect(jobs[0]?.input?.endsWith('Request:\na|b\nc')).toBe(true);
    expect(replies(outbox)).toEqual([{ version: 1, chatId: CHAT, mentionUserId: 'linh', html: mappingQueuedReply }]);
  });

  // ciel/mapping_test.go:177
  it('TestActRejectsOddMessageID', () => {
    const { watcher, state, outbox, cfg } = harness();
    const person = resolvePerson(cfg, 'teams:linh');
    if (person === undefined) throw new Error('no person');
    watcher.act(CHAT, msg('linh', 'x', '../..'), person, { addressedToMe: true, intent: 'code_mapping', mrUrls: [], summary: 'map' });
    expect(state.pendingJobs()).toEqual([]);
    expect(replies(outbox)).toEqual([]);
  });

  // ciel/trail_test.go:42
  it('TestTrailRecordsEveryOutcome', async () => {
    const { watcher, state, cfg } = harness({ result: decision({ addressed_to_me: true, intent: 'question', summary: 'asks' }) });
    const inbox = new Inbox(tmp(), cfg.data_dir, { track: (f, u) => state.trackMessage(f, u) });
    const t0 = new Date(Date.now() - 60_000);
    const at = (s: number): Date => new Date(t0.getTime() + s * 1000);
    writeFileSync(join(inbox.dir, 'sys.json'), inboxJSON('1', 'colleague', t0, 'renamed', CHAT, 'systemEventMessage', 'Colleague'));
    writeFileSync(join(inbox.dir, 'plain.json'), inboxJSON('2', 'colleague', at(1), 'lunch?', CHAT, 'message', 'Colleague'));
    writeFileSync(join(inbox.dir, 'ask.json'), inboxJSON('3', 'colleague', at(2), 'Dat ơi, help?', CHAT, 'message', 'Colleague'));
    writeFileSync(join(inbox.dir, 'dup.json'), inboxJSON('3', 'colleague', at(3), 'Dat ơi, help?', CHAT, 'message', 'Colleague'));
    writeFileSync(join(inbox.dir, 'broken.json'), '{"version":9}');
    await inbox.scan(none, (f, s) => watcher.handle(f, s));
    const rows = Object.fromEntries(state.messages.map((r) => [r.file, r]));
    const want: Record<string, string> = { 'sys.json': 'skipped/system event', 'plain.json': 'skipped/not a candidate', 'ask.json': 'classified/notified', 'dup.json': 'skipped/duplicate', 'broken.json': 'failed/unsupported version 9' };
    for (const [f, outcome] of Object.entries(want)) expect(`${rows[f]?.outcome}/${rows[f]?.reason}`, f).toBe(outcome);
    expect(rows['ask.json']).toMatchObject({ id: '3', chatId: CHAT, senderId: 'colleague', attempts: 1, intent: 'question', addressed: true });
    expect(rows['ask.json']?.sentAt).toBeDefined();
    expect(rows['ask.json']?.claimedAt).toBeDefined();
    expect(readdirSync(inbox.raw).sort()).toEqual(['ask.json', 'dup.json', 'plain.json', 'sys.json']);
    expect(readdirSync(inbox.failed)).toEqual(['broken.json']);
    const raw = JSON.stringify(state.messages);
    expect(raw).not.toContain('Colleague');
    expect(raw).not.toContain('lunch?');
  });

  // ciel/trail_test.go:172, with audee's fixed failure kinds
  it('TestTrailKeepsNoClaudeReplyText', async () => {
    const cases: Array<[string, RunResult | Error, string]> = [
      ['claude fails', new Error('session failed: Colleague asks Dat about the secret lunch plan'), 'claude session failed'],
      ['free text, no schema', { isError: false, text: 'Colleague asks Dat about the secret lunch plan', structured: undefined, denials: [], toolUses: [], durationMs: 1 }, 'classify returned no decision'],
    ];
    for (const [name, result, wantError] of cases) {
      const { watcher, state, cfg } = harness({ result });
      const inbox = new Inbox(tmp(), cfg.data_dir, { track: (f, u) => state.trackMessage(f, u) });
      writeFileSync(join(inbox.dir, '1.json'), inboxJSON('1', 'colleague', new Date(), 'Dat, secret lunch plan?', CHAT, 'message', 'Colleague'));
      await inbox.scan(none, (f, s) => watcher.handle(f, s));
      inbox.failingSince.set('1.json', Date.now() - giveUpAfterMs);
      await inbox.scan(none, (f, s) => watcher.handle(f, s));
      const r = state.messages[0];
      expect(r, name).toMatchObject({ outcome: outcomeFailed, lastError: wantError, reason: 'gave up after 30m0s: ' + wantError });
      const raw = JSON.stringify(state.messages);
      expect(raw, name).not.toContain('lunch');
      expect(raw, name).not.toContain('Colleague');
    }
  });

  // ciel/trail_test.go:218
  it('TestTrailKeepsNoInboxFileContent', async () => {
    const { watcher, state, cfg } = harness();
    const inbox = new Inbox(tmp(), cfg.data_dir, { track: (f, u) => state.trackMessage(f, u) });
    writeFileSync(join(inbox.dir, 'bad.json'), inboxJSON('1', 'colleague', new Date(), 'hi').replace('"createdDateTime":"', '"createdDateTime":"secret-lunch-'));
    await inbox.scan(none, (f, s) => watcher.handle(f, s));
    expect(state.messages[0]).toMatchObject({ outcome: outcomeFailed, reason: 'not a valid inbox file' });
    expect(JSON.stringify(state.messages)).not.toContain('secret-lunch');
  });

  // ciel/trail_test.go:201
  it('TestClassifyTimeoutIsNamed', async () => {
    const { watcher } = harness({ result: new Error('timed out after 200 ms') });
    const err = await watcher.handle(file(inboxJSON('1', 'colleague', new Date(), 'Dat ơi')), none).catch((e: unknown) => e);
    expect(trailReason(err)).toBe('classify timed out');
  });

  // ciel/ciel_test.go:559
  it('TestQuietAlert', () => {
    const teams = testConfig({ teams: { quietAfter: '4h', workHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' } } }).channels.teams;
    const d = (day: number, h: number, m = 0): Date => new Date(2026, 9, day, h, m);
    const friday = d(9, 17);
    const cases: Array<[string, Date, Date | undefined, boolean]> = [
      ['quiet for 5h in work hours', d(8, 15), d(8, 10), true],
      ['recent file', d(8, 15), d(8, 12), false],
      ['evening', d(8, 20), d(8, 10), false],
      ['saturday', d(10, 15), friday, false],
      ['monday morning after a quiet weekend', d(12, 10), friday, false],
      ['monday afternoon still quiet', d(12, 13, 30), friday, true],
      ['never received a file', d(12, 13, 30), undefined, true],
    ];
    for (const [name, now, last, want] of cases) expect(quietAlertDue(teams, now, last), name).toBe(want);
  });

  // ciel/ciel_test.go:590
  it('TestQuietAlertFiresOnce', () => {
    const { watcher, state, notes } = harness({ teams: { quietAfter: '1h', workHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' } } });
    const noon = new Date(2026, 9, 8, 12, 0);
    const plus = (h: number, m = 0): Date => new Date(noon.getTime() + h * 3600_000 + m * 60_000);
    const alerts = (): number => notes.filter((n) => n.includes('inbox is quiet')).length;
    watcher.checkQuiet(noon);
    watcher.checkQuiet(plus(1));
    expect(alerts()).toBe(1);
    state.inboxArrived(plus(2));
    watcher.checkQuiet(plus(2, 1));
    watcher.checkQuiet(plus(4));
    expect(alerts()).toBe(2);
  });

  // ciel/ciel_test.go:1069
  it('TestTakeReruns', () => {
    const { watcher, state, outbox, cfg } = harness();
    const job: Job = { kind: 'review', channel: 'teams', chatId: '19:chat-a@thread.v2', principal: 'teams:kha', requesterName: 'kha', mrUrl: 'https://gitlab.example.com/g/p/-/merge_requests/12', requestedAt: new Date().toISOString() };
    state.startReview(job.mrUrl ?? '', reviewCooldownMs);
    const dir = rerunDir(cfg.data_dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), JSON.stringify(job));
    const mapping: Job = { kind: 'code_mapping', channel: 'teams', chatId: '19:chat-b@thread.v2', principal: 'teams:linh', requesterName: 'linh', messageId: '1791513774214', input: 'sample', requestedAt: '2026-10-14T00:00:00.000Z' };
    writeFileSync(join(dir, 'm.json'), JSON.stringify(mapping));
    writeFileSync(join(dir, 'bad.json'), '{"mrUrl":""}');
    watcher.takeReruns();
    expect(state.pendingJobs()).toEqual([job, mapping]);
    const got = replies(outbox);
    const want: Record<string, [string, string]> = { '19:chat-a@thread.v2': ['kha', replyHTML(queuedReply, job.mrUrl ?? '')], '19:chat-b@thread.v2': ['linh', mappingQueuedReply] };
    expect(got).toHaveLength(2);
    for (const r of got) expect([r.mentionUserId, r.html]).toEqual(want[r.chatId]);
    expect(state.reviews[mapping.messageId ?? '']).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  // ciel/kbquery_test.go:596
  it('TestHandleKBQueryRedeliveredAfterCrash', async () => {
    const { watcher, state, outbox } = harness();
    const f = file(inboxJSON('1791513774214', 'linh', new Date(), 'Dat kb_query one?'));
    state.addJob({ kind: 'kb_query', channel: 'teams', chatId: CHAT, principal: 'teams:linh', requesterName: 'linh', messageId: f.message.id, input: 'one?', requestedAt: new Date().toISOString() });
    await watcher.handle(f, none);
    expect(state.pendingJobs()).toHaveLength(1);
    expect(replies(outbox)).toEqual([]);
    expect(state.hasSeen(f.message.id)).toBe(true);
  });

  it('TestTeamsDeniedRequesterGetsRefusal', async () => {
    const { watcher, state, outbox, inputs } = harness();
    const json = inboxJSON('1', 'stranger', new Date(), 'review giúp em ' + MR).replace('"mentions":', '"x":').replace('"body":', '"mentions":[{"mentioned":{"user":{"id":"me-id"}}}],"body":');
    await watcher.handle(file(json), none);
    expect(replies(outbox)).toEqual([{ version: 1, chatId: CHAT, mentionUserId: 'stranger', html: deniedText('audee') }]);
    expect(inputs).toHaveLength(0);
    expect(state.pendingJobs()).toEqual([]);
    expect(state.messages[0]).toMatchObject({ outcome: outcomeDenied });
  });

  it('TestUnknownUnmentionedSenderIgnored', async () => {
    const { watcher, state, outbox, inputs } = harness();
    await watcher.handle(file(inboxJSON('1', 'stranger', new Date(), 'anh Dat review giúp em ' + MR)), none);
    expect(replies(outbox)).toEqual([]);
    expect(inputs).toHaveLength(0);
    expect(state.messages[0]).toMatchObject({ outcome: outcomeSkipped, reason: 'unknown sender' });
  });

  it('TestCapabilityNotGrantedGetsRefusal', async () => {
    const { watcher, state, outbox, inputs } = harness({ grants: { colleague: ['kb_query'] }, result: decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: [MR], summary: 'review' }) });
    await watcher.handle(file(inboxJSON('1', 'colleague', new Date(), 'anh Dat review giúp em ' + MR)), none);
    expect(replies(outbox)).toEqual([{ version: 1, chatId: CHAT, mentionUserId: 'colleague', html: deniedText('review') }]);
    expect(state.pendingJobs()).toEqual([]);
    expect(inputs).toHaveLength(1); // the classifier ran; no capability session followed
    await watcher.handle(file(inboxJSON('1791513774214', 'colleague', new Date(), 'Dat grafana_query x')), none);
    expect(state.pendingJobs()).toEqual([]);
  });

  it('TestChatNotAllowedIgnored', async () => {
    const { watcher, state, outbox, inputs } = harness();
    await watcher.handle(file(inboxJSON('1', 'colleague', new Date(), 'anh Dat review giúp em ' + MR, '19:other@thread.v2')), none);
    expect(state.messages[0]).toMatchObject({ outcome: outcomeSkipped, reason: 'chat not allowed' });
    expect(inputs).toHaveLength(0);
    expect(replies(outbox)).toEqual([]);
    expect(state.chatHistory('19:other@thread.v2')).toEqual([]);
    expect(state.hasSeen('1')).toBe(false);
  });

  it('TestRunCallbackThrowRepliesFailed', async () => {
    const scratch = tmp();
    const review: Capability = async () => { throw new Error('boom'); };
    const kbRead: Capability = async () => ({ reply: { html: 'answer', file: { name: 'a.json', content: '{}' } }, removeAfterReply: scratch, event: { status: 'done', sessionId: 's1' } });
    const { watcher, state, outbox, cfg } = harness({ capabilities: { review, kb_read: kbRead } });
    const job: Job = { kind: 'review', channel: 'teams', chatId: CHAT, principal: 'teams:kha', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() };
    expect(state.startReview(MR, reviewCooldownMs)).toBe(true);
    expect(await watcher.runJob(job, none)).toBe('done');
    expect(replies(outbox)).toEqual([{ version: 1, chatId: CHAT, mentionUserId: 'kha', html: replyHTML(failedReply, MR) }]);
    expect(state.startReview(MR, reviewCooldownMs)).toBe(true); // the cooldown was lifted
    expect(events(cfg.data_dir).map((e) => `${e['kind']}/${e['status']}`)).toEqual(['review/started', 'review/failed']);
    const kb: Job = { kind: 'kb_query', channel: 'teams', chatId: CHAT, principal: 'teams:linh', requesterName: 'linh', messageId: '1791513774214', input: 'q', requestedAt: new Date().toISOString() };
    expect(await watcher.runJob(kb, none)).toBe('done');
    const withFile = replies(outbox).find((r) => r.file !== undefined);
    expect(withFile).toMatchObject({ chatId: CHAT, mentionUserId: 'linh', html: 'answer', file: { name: 'a.json', content: '{}' } });
    expect(existsSync(scratch)).toBe(false);
    expect(events(cfg.data_dir).at(-1)).toMatchObject({ kind: 'kb_query', status: 'done', session_id: 's1', msg_id: '1791513774214' });
  });

  it('TestRunCallbackInterruptedKeepsJob', async () => {
    const review: Capability = async () => { throw new InterruptedError(); };
    const { watcher, state, outbox } = harness({ capabilities: { review } });
    const job: Job = { kind: 'review', channel: 'teams', chatId: CHAT, principal: 'teams:kha', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() };
    state.startReview(MR, reviewCooldownMs);
    expect(await watcher.runJob(job, none)).toBe('interrupted');
    expect(replies(outbox)).toEqual([]);
    expect(state.startReview(MR, reviewCooldownMs)).toBe(false); // the cooldown stays
  });

  it('TestShadowNeverRunsSavedJobsOrReruns', async () => {
    let calls = 0;
    const review: Capability = async () => { calls++; return { event: { status: 'done' } }; };
    const { watcher, state, cfg } = harness({ capabilities: { review }, teams: { shadow: true } });
    const job: Job = { kind: 'review', channel: 'teams', chatId: CHAT, principal: 'teams:kha', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() };
    state.addJob(job);
    ensureRerunDir(cfg.data_dir);
    writeFileSync(join(rerunDir(cfg.data_dir), 'r.json'), JSON.stringify(job));
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    await watcher.run(stop.signal);
    await watcher.queue.stop();
    expect(calls).toBe(0);
    expect(state.pendingJobs()).toHaveLength(1);
    expect(readdirSync(rerunDir(cfg.data_dir))).toEqual(['r.json']);
  });

  it('TestRunJobRechecksGrant', async () => {
    let calls = 0;
    const review: Capability = async () => { calls++; return { event: { status: 'done' } }; };
    const { watcher, outbox } = harness({ capabilities: { review }, grants: { kha: ['kb_query'] } });
    const job: Job = { kind: 'review', channel: 'teams', chatId: CHAT, principal: 'teams:kha', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() };
    expect(await watcher.runJob(job, none)).toBe('done');
    expect(calls).toBe(0);
    expect(replies(outbox)).toHaveLength(1);
  });

  it('TestUnconfiguredCapabilityGetsUnavailableReply', async () => {
    const { watcher, state, outbox, cfg, notes } = harness({ result: new Error('must not classify') });
    delete cfg.capabilities['kb_query'];
    await watcher.handle(file(inboxJSON('1791513774214', 'linh', new Date(), 'anh Dat kb_query past segment hoạt động thế nào?')), none);
    expect(state.pendingJobs()).toEqual([]);
    expect(replies(outbox)).toEqual([{ version: 1, chatId: CHAT, mentionUserId: 'linh', html: unavailableText('kb_query') }]);
    expect(notes.some((n) => n.includes('not configured'))).toBe(true);
    expect(state.hasSeen('1791513774214')).toBe(true);
  });

  it('TestClassifyFailureEventKeepsNoModelText', async () => {
    const { watcher, cfg } = harness({ result: new Error('session failed: Colleague asks Dat about the secret lunch plan') });
    await watcher.handle(file(inboxJSON('1', 'colleague', new Date(), 'Dat ơi')), none).catch(() => undefined);
    const last = events(cfg.data_dir).at(-1);
    expect(last).toMatchObject({ kind: 'classify', status: 'failed', reason: 'claude session failed' });
    expect(JSON.stringify(last)).not.toContain('lunch');
  });

  it('TestLimitReplyNamesTheRightKind', () => {
    expect(pendingText('kb_query')).toBe(kbQueryPendingReply);
    expect(pendingText('review')).not.toContain('kb_query');
    expect(pendingText('grafana')).not.toContain('kb_query');
  });

  it('TestClassifierUsesItsOwnAuth', async () => {
    const { watcher, cfg, inputs } = harness();
    cfg.classifier.auth = 'api_key';
    cfg.classifier.model = 'claude-opus-4-8';
    cfg.auth.base_url = 'https://gateway.example';
    await watcher.handle(file(inboxJSON('1', 'colleague', new Date(), 'Dat ơi')), none);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ auth: 'api_key', apiKeyItem: 'audee-anthropic', baseUrl: 'https://gateway.example', options: { model: 'claude-opus-4-8' } });
  });
});

// utimesSync is referenced so the import stays used in every build of this file
void utimesSync;
