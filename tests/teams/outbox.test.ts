import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encode, Outbox } from '../../src/teams/outbox.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'audee-outbox-'));

describe('teams outbox', () => {
  // ciel/ciel_test.go:501
  it('TestOutboxReply', () => {
    const out = Outbox.forOneDrive(tmp(), tmp());
    out.reply('19:c@thread.v2', 'user-1', 'Reviewed: PASS <b>ok</b> & done');
    const entries = readdirSync(out.dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.endsWith('.json')).toBe(true);
    expect(readdirSync(out.tmp)).toEqual([]);
    const raw = readFileSync(join(out.dir, entries[0] ?? ''), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, chatId: '19:c@thread.v2', mentionUserId: 'user-1', html: 'Reviewed: PASS <b>ok</b> & done' });
    // Ciel's Go encoder: sorted keys and HTML-safe escapes, so the file is byte-compatible
    expect(raw).toBe('{"chatId":"19:c@thread.v2","html":"Reviewed: PASS \\u003cb\\u003eok\\u003c/b\\u003e \\u0026 done","mentionUserId":"user-1","version":1}');
    expect(encode({ version: 1, chatId: 'c', mentionUserId: 'u', html: 'a\u2028b\u2029c' })).toBe('{"chatId":"c","html":"a\\u2028b\\u2029c","mentionUserId":"u","version":1}');
  });

  // ciel/ciel_test.go:481
  it('TestOutboxReplyFile', () => {
    const out = Outbox.forOneDrive(tmp(), tmp());
    out.replyFile('19:c@thread.v2', 'user-1', 'see file', 'a.json', '{"x":1}');
    const entries = readdirSync(out.dir);
    const got = JSON.parse(readFileSync(join(out.dir, entries[0] ?? ''), 'utf8')) as { html: string; file: { name: string; content: string } };
    expect(got.html).toBe('see file');
    expect(got.file).toEqual({ name: 'a.json', content: '{"x":1}' });
  });
});
