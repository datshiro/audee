import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shadowReport } from '../src/shadow-report.js';

const lines = (events: Array<Record<string, unknown>>): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

function files(ciel: Array<Record<string, unknown>>, audee: Array<Record<string, unknown>>): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), 'audee-report-'));
  const c = join(dir, 'ciel.jsonl');
  const a = join(dir, 'audee.jsonl');
  writeFileSync(c, lines(ciel));
  writeFileSync(a, lines(audee));
  return [c, a];
}

describe('shadow report', () => {
  it('TestShadowReportAgreement', () => {
    const [c, a] = files([
      { ts: '2026-10-17T01:00:00Z', kind: 'classify', status: 'classified', msg_id: '1', addressed: true, intent: 'review_mr', mrs: 1 },
      { ts: '2026-10-17T01:01:00Z', kind: 'classify', status: 'classified', msg_id: '2', addressed: true, intent: 'question' },
      { ts: '2026-10-17T01:02:00Z', kind: 'classify', status: 'classified', msg_id: '3', intent: 'other' },
      { ts: '2026-10-17T01:03:00Z', kind: 'classify', status: 'failed', msg_id: '4', reason: 'x' },
      { ts: '2026-10-17T01:04:00Z', kind: 'review', status: 'posted', mr: 'https://x/-/merge_requests/1' },
    ], [
      { ts: '2026-10-17T01:00:30Z', kind: 'classify', status: 'classified', shadow: true, msg_id: '1', addressed: true, intent: 'review_mr', allowed: false },
      { ts: '2026-10-17T01:01:30Z', kind: 'classify', status: 'classified', shadow: true, msg_id: '2', addressed: true, intent: 'other', allowed: true },
      { ts: '2026-10-17T01:02:30Z', kind: 'classify', status: 'classified', shadow: true, msg_id: '3', addressed: false, intent: 'other', allowed: true },
      { ts: '2026-10-17T01:05:00Z', kind: 'classify', status: 'classified', shadow: true, token: true, msg_id: '5', intent: 'kb_query', addressed: true, allowed: true },
      { ts: '2026-10-17T01:06:00Z', kind: 'classify', status: 'classified', shadow: true, msg_id: '9', addressed: true, intent: 'question', allowed: true },
    ]);
    const r = shadowReport(c, a);
    expect(r.lines).toEqual(['compared: 3', 'agreement: 2/3 (66.7%)', 'would be denied: 1']);
    expect(shadowReport(c, a, '2026-10-17T01:01:00Z').compared).toBe(2);
    expect(shadowReport(join(tmpdir(), 'nope.jsonl'), a).lines[0]).toBe('compared: 0');
  });

  it('TestShadowReportTreatsMissingAddressedAsFalse', () => {
    const [c, a] = files([{ ts: 't', kind: 'classify', status: 'classified', msg_id: '1' }], [{ ts: 't', kind: 'classify', status: 'classified', shadow: true, msg_id: '1', addressed: false, intent: '', allowed: true }]);
    expect(shadowReport(c, a).lines).toEqual(['compared: 1', 'agreement: 1/1 (100.0%)', 'would be denied: 0']);
  });

  it('TestShadowReportKeepsLastEventPerMessage', () => {
    const [c, a] = files([
      { ts: 't1', kind: 'classify', status: 'classified', msg_id: '1', addressed: true, intent: 'review_mr' },
      { ts: 't2', kind: 'classify', status: 'classified', msg_id: '1', addressed: true, intent: 'question' },
    ], [
      { ts: 't1', kind: 'classify', status: 'classified', shadow: true, msg_id: '1', addressed: false, intent: 'other', allowed: true },
      { ts: 't2', kind: 'classify', status: 'classified', shadow: true, msg_id: '1', addressed: true, intent: 'question', allowed: true },
    ]);
    expect(shadowReport(c, a).lines[1]).toBe('agreement: 1/1 (100.0%)');
  });
});
