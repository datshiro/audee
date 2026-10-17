import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../../src/shadow-report.js';
import type { RunInput, RunResult } from '../../src/runner/run.js';
import { loadState } from '../../src/state/state.js';
import { Outbox } from '../../src/teams/outbox.js';
import { ShadowSource, shadowHandler } from '../../src/teams/shadow.js';
import { testConfig } from '../helpers/test-config.js';

const CHAT = '19:chat@thread.v2';
const MR_PATTERN = 'https://gitlab\\.example\\.com/[^\\s"\'<>]+/-/merge_requests/\\d+';
const MR = 'https://gitlab.example.com/g/p/-/merge_requests/5';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'audee-shadow-'));
const none = new AbortController().signal;
const inboxJSON = (id: string, from: string, content: string, mention = false): string =>
  JSON.stringify({ version: 1, chatId: CHAT, meId: 'me-id', message: { id, messageType: 'message', createdDateTime: new Date().toISOString(), from: { user: { id: from } }, body: { contentType: 'text', content }, mentions: mention ? [{ mentioned: { user: { id: 'me-id' } } }] : [] } });
const decision = (d: Record<string, unknown>): RunResult => ({ isError: false, text: '{}', structured: { mr_urls: [], summary: '', ...d }, denials: [], toolUses: [], durationMs: 1 });

function harness(result: RunResult = decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: [MR] })) {
  const cfg = testConfig({ teams: { chats: [CHAT], aliases: ['Dat'], mrUrlPattern: MR_PATTERN, shadow: true }, peopleIds: ['colleague'], grants: { colleague: ['kb_query'] }, authOwner: 'subscription' });
  const state = loadState(cfg.data_dir);
  const raw = tmp();
  const failed = tmp();
  const inputs: RunInput[] = [];
  const run = async (input: RunInput): Promise<RunResult> => { inputs.push(input); return result; };
  const source = new ShadowSource([raw, failed], state);
  const handle = shadowHandler({ cfg, state, run });
  const snapshot = (): Record<string, string> => Object.fromEntries([...readdirSync(raw).map((n) => [`raw/${n}`, readFileSync(join(raw, n), 'utf8')]), ...readdirSync(failed).map((n) => [`failed/${n}`, readFileSync(join(failed, n), 'utf8')])]);
  return { cfg, state, raw, failed, inputs, source, handle, snapshot, events: () => readEvents(join(cfg.data_dir, 'events.jsonl')) };
}

describe('shadow mode', () => {
  it('TestShadowNeverMovesCielFiles', async () => {
    const h = harness();
    writeFileSync(join(h.raw, '1.json'), inboxJSON('1', 'colleague', 'anh Dat review giúp em ' + MR));
    writeFileSync(join(h.failed, '2.json'), inboxJSON('2', 'stranger', 'Dat ơi help', true));
    const before = h.snapshot();
    expect(await h.source.scan(none, h.handle)).toBe(2);
    expect(h.snapshot()).toEqual(before);
    expect(h.state.hasShadowSeen('1.json')).toBe(true);
    expect(h.state.hasShadowSeen('2.json')).toBe(true);
  });

  it('TestShadowNeverQueues', async () => {
    const h = harness(decision({ addressed_to_me: true, intent: 'code_mapping' }));
    writeFileSync(join(h.raw, '1791513774214.json'), inboxJSON('1791513774214', 'colleague', 'anh Dat làm code mapping giúp em'));
    writeFileSync(join(h.raw, '1791513774215.json'), inboxJSON('1791513774215', 'colleague', 'Dat kb_query how does pusher retry?'));
    await h.source.scan(none, h.handle);
    expect(h.state.pendingJobs()).toEqual([]);
    expect(h.events().map((e) => e['kind'])).toEqual(['classify', 'classify']);
    expect(h.state.chatHistory(CHAT)).toHaveLength(2); // context for later classifications, as Ciel keeps it
  });

  it('TestShadowNeverWritesOneDriveOutbox', async () => {
    const h = harness();
    const oneDrive = tmp();
    const outbox = Outbox.forOneDrive(oneDrive, tmp());
    writeFileSync(join(h.raw, '1.json'), inboxJSON('1', 'stranger', 'Dat ơi review ' + MR, true));
    await h.source.scan(none, h.handle);
    expect(readdirSync(outbox.dir)).toEqual([]);
    expect(readdirSync(join(oneDrive, 'outbox'))).toEqual([]);
  });

  it('TestShadowSkipsSeenAndUnparsable', async () => {
    const h = harness();
    writeFileSync(join(h.raw, 'broken.json'), '{"version":1,');
    writeFileSync(join(h.raw, '1.json'), inboxJSON('1', 'colleague', 'Dat ơi help'));
    expect(await h.source.scan(none, h.handle)).toBe(1);
    expect(h.inputs).toHaveLength(1);
    expect(h.state.hasShadowSeen('broken.json')).toBe(true);
    expect(await h.source.scan(none, h.handle)).toBe(0);
    expect(h.inputs).toHaveLength(1);
    expect(h.snapshot()['raw/broken.json']).toBe('{"version":1,');
  });

  it('TestShadowClassifiesUnknownSendersOnOwnerAuth', async () => {
    const h = harness();
    writeFileSync(join(h.raw, '1.json'), inboxJSON('1', 'stranger', 'Dat ơi review ' + MR, true));
    writeFileSync(join(h.raw, '2.json'), inboxJSON('2', 'colleague', 'anh Dat review giúp em ' + MR));
    writeFileSync(join(h.raw, '3.json'), inboxJSON('3', 'colleague', 'Dat kb_query how?'));
    writeFileSync(join(h.raw, '4.json'), inboxJSON('4', 'colleague', 'lunch?'));
    await h.source.scan(none, h.handle);
    expect(h.inputs).toHaveLength(2); // the stranger and the colleague were classified; the token and the non-candidate were not
    for (const input of h.inputs) {
      expect(input.auth).toBe('subscription');
      expect(input.apiKeyItem).toBeUndefined();
    }
    const byMsg = Object.fromEntries(h.events().map((e) => [e['msg_id'], e]));
    expect(byMsg['1']).toMatchObject({ kind: 'classify', shadow: true, intent: 'review_mr', addressed: true, principal: 'teams:stranger', allowed: false });
    expect(byMsg['2']).toMatchObject({ shadow: true, intent: 'review_mr', principal: 'teams:colleague', allowed: false }); // granted kb_query only
    expect(byMsg['3']).toMatchObject({ shadow: true, token: true, intent: 'kb_query', addressed: true, principal: 'teams:colleague', allowed: true });
    expect(byMsg['4']).toBeUndefined();
  });
});
