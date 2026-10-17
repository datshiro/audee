import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, eventsPath } from '../src/events.js';

describe('events', () => {
  it('TestAppendEventWritesOneLine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audee-events-'));
    const at = new Date('2026-10-17T10:00:00.000Z');
    appendEvent(dir, { kind: 'classify', status: 'classified', msgId: '1', addressed: false, intent: '', mrs: 0, shadow: true, allowed: false }, at);
    appendEvent(dir, { kind: 'review', status: 'posted', mrUrl: 'https://gitlab.example.com/g/p/-/merge_requests/1', costUsd: 1.5, numTurns: 7, durationMs: 1200, toolUses: ['Read'], denials: [] }, at);
    const lines = readFileSync(eventsPath(dir), 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    const second = JSON.parse(lines[1] ?? '') as Record<string, unknown>;
    // Ciel's omitempty shape: false, 0 and '' are omitted; audee's additions are kept even when false.
    expect(first).toEqual({ ts: '2026-10-17T10:00:00.000Z', kind: 'classify', status: 'classified', msg_id: '1', shadow: true, allowed: false });
    expect(second).toEqual({ ts: '2026-10-17T10:00:00.000Z', kind: 'review', status: 'posted', mr: 'https://gitlab.example.com/g/p/-/merge_requests/1', cost_usd: 1.5, num_turns: 7, duration_ms: 1200, tool_uses: ['Read'], denials: [] });
  });
});
