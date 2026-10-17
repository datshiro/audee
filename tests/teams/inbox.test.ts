import { chmodSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InterruptedError } from '../../src/runner/run.js';
import { Inbox, type InboxFile, giveUpAfterMs, parseInboxFile, rawRetentionMs } from '../../src/teams/inbox.js';
import { principalOf, sender } from '../../src/teams/message.js';

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`../fixtures/teams/${name}`, import.meta.url)));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'audee-inbox-'));
const files = (dir: string): string[] => readdirSync(dir).sort();
const none = new AbortController().signal;

// ciel/ciel_test.go:306 inboxJSON
const inboxJSON = (msgId: string, from: string, at: Date): string =>
  JSON.stringify({ version: 1, chatId: 'chat', meId: 'me-id', message: { id: msgId, messageType: 'message', createdDateTime: at.toISOString(), from: { user: { id: from } }, body: { contentType: 'text', content: `hello ${msgId}` } } });

function testInbox(): Inbox {
  return new Inbox(tmp(), tmp());
}

describe('teams inbox', () => {
  // ciel/ciel_test.go:270 (the detector assertions move to phase 11)
  it('TestParseInboxSample', () => {
    const f = parseInboxFile(fixture('inbox-sample.json'));
    expect([f.chatId, f.meId, f.message.id, f.message.messageType]).toEqual(['19:be-quick-chat@thread.v2', 'me-id', '1759934400000', 'message']);
    expect(sender(f.message)?.id).toBe('colleague-id');
    expect(f.message.mentions?.[0]?.mentioned?.user?.id).toBe('me-id');
    expect(f.message.body.content).toContain('review giúp em');
  });

  // ciel/ciel_test.go:292
  it('TestParseInboxFileRejectsBrokenContract', () => {
    const cases: Record<string, string> = {
      'not json': '{"version":1,',
      'wrong version': '{"version":2,"chatId":"c","meId":"me","message":{"id":"1"}}',
      'no chat id': '{"version":1,"meId":"me","message":{"id":"1"}}',
      'no me id': '{"version":1,"chatId":"c","message":{"id":"1"}}',
      'no message id': '{"version":1,"chatId":"c","meId":"me","message":{}}',
    };
    for (const [name, raw] of Object.entries(cases)) expect(() => parseInboxFile(raw), name).toThrow();
    expect(() => parseInboxFile('{"version":1,')).toThrow('not a valid inbox file');
  });

  // ciel/ciel_test.go:734 (plainText and the candidate check move to phase 11)
  it('TestParseRealInboxFile', () => {
    const f = parseInboxFile(fixture('inbox-real-text.json'));
    expect([f.chatId, f.meId, f.message.id, f.message.messageType]).toEqual(['19:test-chat@thread.v2', 'me-id', '1791513774214', 'message']);
    expect(Number.isNaN(Date.parse(f.message.createdDateTime ?? ''))).toBe(false);
    expect(sender(f.message)?.id).toBe('colleague-id');
    expect(f.message.body.content).toBe('Oke lát a gửi');
  });

  // ciel/ciel_test.go:329
  it('TestInboxScan', async () => {
    const inbox = testInbox();
    const t0 = new Date(Date.UTC(2026, 9, 8, 10, 0, 0));
    writeFileSync(join(inbox.dir, '2.json'), inboxJSON('2', 'a', new Date(t0.getTime() + 60_000)));
    writeFileSync(join(inbox.dir, '1.json'), inboxJSON('1', 'a', t0));
    writeFileSync(join(inbox.dir, 'contract.json'), '{"version":9}');
    writeFileSync(join(inbox.dir, 'partial.json'), '{"version":1,');
    writeFileSync(join(inbox.dir, 'stale.json'), '{"version":1,');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(inbox.dir, 'stale.json'), old, old);
    writeFileSync(join(inbox.dir, 'notes.txt'), 'ignored');
    const locked = join(inbox.dir, '3.json');
    writeFileSync(locked, inboxJSON('3', 'a', t0));
    chmodSync(locked, 0);

    let got: string[] = [];
    const handle = async (f: InboxFile): Promise<void> => { got.push(f.message.id); };
    expect(await inbox.scan(none, handle)).toBe(4);
    expect(got.join(',')).toBe('1,2');
    expect(files(inbox.dir)).toEqual(['3.json', 'notes.txt', 'partial.json']);
    expect(files(inbox.processing)).toEqual([]);
    expect(files(inbox.failed)).toEqual(['contract.json', 'stale.json']);
    expect(files(inbox.raw)).toEqual(['1.json', '2.json']);

    chmodSync(locked, 0o600);
    got = [];
    await inbox.scan(none, handle);
    expect(got.join(',')).toBe('3');
    expect(files(inbox.dir)).toEqual(['notes.txt', 'partial.json']);
  });

  // ciel/ciel_test.go:371
  it('TestInboxScanRecoversInterruptedClaims', async () => {
    const inbox = testInbox();
    writeFileSync(join(inbox.processing, '7.json'), inboxJSON('7', 'a', new Date()));
    const got: string[] = [];
    const n = await inbox.scan(none, async (f) => { got.push(f.message.id); });
    expect(got).toEqual(['7']);
    expect(n).toBe(0); // a recovered file is not a new arrival
    expect(files(inbox.processing)).toEqual([]);
  });

  // ciel/ciel_test.go:385
  it('TestInboxScanKeepsFailedFiles', async () => {
    const inbox = testInbox();
    writeFileSync(join(inbox.dir, '1.json'), inboxJSON('1', 'a', new Date()));
    let calls = 0;
    const failing = async (): Promise<void> => { calls++; throw new Error('claude unreachable'); };
    await inbox.scan(none, failing);
    await inbox.scan(none, failing);
    expect(calls).toBe(2);
    expect(files(inbox.processing)).toEqual(['1.json']);
    inbox.failingSince.set('1.json', Date.now() - giveUpAfterMs);
    await inbox.scan(none, failing);
    expect(files(inbox.processing)).toEqual([]);
    expect(files(inbox.failed)).toEqual(['1.json']);
  });

  // ciel/ciel_test.go:404, plus a handler that throws InterruptedError
  it('TestInboxScanKeepsFileOnShutdown', async () => {
    const inbox = testInbox();
    writeFileSync(join(inbox.dir, '1.json'), inboxJSON('1', 'a', new Date()));
    const controller = new AbortController();
    await inbox.scan(controller.signal, async () => { controller.abort(); });
    expect(files(inbox.processing)).toEqual(['1.json']);
    expect(files(inbox.raw)).toEqual([]);

    const other = testInbox();
    writeFileSync(join(other.dir, '1.json'), inboxJSON('1', 'a', new Date()));
    writeFileSync(join(other.dir, '2.json'), inboxJSON('2', 'a', new Date()));
    const handled: string[] = [];
    await other.scan(none, async (f) => { handled.push(f.message.id); throw new InterruptedError(); });
    expect(handled).toEqual(['1']);
    expect(files(other.processing)).toEqual(['1.json', '2.json']);
    expect(other.failingSince.size).toBe(0);
  });

  // ciel/trail_test.go:128
  it('TestInboxExpiresKeptFiles', () => {
    const inbox = testInbox();
    const old = new Date(Date.now() - rawRetentionMs - 60_000);
    for (const dir of [inbox.raw, inbox.failed]) {
      writeFileSync(join(dir, 'old.json'), '{}');
      writeFileSync(join(dir, 'new.json'), '{}');
      utimesSync(join(dir, 'old.json'), old, old);
    }
    writeFileSync(join(inbox.processing, 'busy.json'), '{}');
    utimesSync(join(inbox.processing, 'busy.json'), old, old);
    inbox.expire(new Date());
    expect(files(inbox.raw)).toEqual(['new.json']);
    expect(files(inbox.failed)).toEqual(['new.json']);
    expect(files(inbox.processing)).toEqual(['busy.json']);
  });

  // ciel/trail_test.go:149
  it('TestKeptFileRetentionStartsWhenHandled', async () => {
    const inbox = testInbox();
    const path = join(inbox.dir, '1.json');
    writeFileSync(path, inboxJSON('1', 'a', new Date()));
    const old = new Date(Date.now() - rawRetentionMs - 3600_000); // OneDrive kept an old timestamp
    utimesSync(path, old, old);
    await inbox.scan(none, async () => {});
    inbox.expire(new Date());
    expect(files(inbox.raw)).toEqual(['1.json']);

    writeFileSync(join(inbox.dir, '2.json'), inboxJSON('2', 'a', new Date()));
    utimesSync(join(inbox.dir, '2.json'), old, old);
    const down = async (): Promise<void> => { throw new Error('down'); };
    await inbox.scan(none, down);
    inbox.failingSince.set('2.json', Date.now() - giveUpAfterMs);
    await inbox.scan(none, down);
    inbox.expire(new Date());
    expect(files(inbox.failed)).toEqual(['2.json']);
  });

  it('TestPrincipalOfUsesSenderId', () => {
    const f = parseInboxFile(fixture('inbox-sample.json'));
    expect(principalOf(f.message)).toBe('teams:colleague-id');
    expect(principalOf({ id: '1', body: {} })).toBeUndefined();
    expect(principalOf({ id: '1', body: {}, from: { user: null } })).toBeUndefined();
    expect(principalOf({ id: '1', body: {}, from: { user: { id: '' } } })).toBeUndefined();
  });
});
