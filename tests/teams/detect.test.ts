import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASSIFY_DENIED_TOOLS } from '../../src/fence/constants.js';
import type { RunInput, RunResult } from '../../src/runner/run.js';
import { ClassifyError, type ClassifySession, Detector, plainText, requestText, triggersOf } from '../../src/teams/detect.js';
import { parseInboxFile } from '../../src/teams/inbox.js';
import type { ChatMessage } from '../../src/teams/message.js';
import { testConfig } from '../helpers/test-config.js';

// ciel/ciel_test.go:17-36
const MR_PATTERN = 'https://gitlab\\.example\\.com/[^\\s"\'<>]+/-/merge_requests/\\d+';
const testDetector = (): Detector => new Detector({ aliases: ['Dat', 'anh Đạt'], mrUrlPattern: MR_PATTERN }, 'me-id');
const msg = (from: string, html: string, ...mentioned: string[]): ChatMessage => ({
  id: '1', messageType: 'message', from: { user: { id: from } }, body: { contentType: 'html', content: html },
  mentions: mentioned.map((id) => ({ mentioned: { user: { id } } })),
});
const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`../fixtures/teams/${name}`, import.meta.url)));
const decision = (d: Record<string, unknown>): RunResult => ({ isError: false, text: '{}', structured: d, denials: [], toolUses: [], durationMs: 1 });

function session(result: RunResult | Error, inputs: RunInput[] = []): ClassifySession {
  return {
    run: async (input) => { inputs.push(input); if (result instanceof Error) throw result; return result; },
    model: 'claude-opus-5-5', effort: 'low', timeoutMs: 180_000, cwd: process.cwd(), auth: 'subscription', signal: new AbortController().signal,
  };
}

describe('detector', () => {
  // ciel/ciel_test.go:38
  it('TestRequestTextKeepsLines', () => {
    const cases: Array<[string, string]> = [['a|b|c<br>d', 'a|b|c\nd'], ['<p>x\ty</p><p>z</p>', 'x\ty\nz'], ['&lt;struct name=&quot;A&quot;&gt;', '<struct name="A">'], ['a&nbsp;&nbsp;b', 'a  b']];
    for (const [html, want] of cases) expect(requestText(msg('u', html)), html).toBe(want);
  });

  // ciel/ciel_test.go:52
  it('TestPlainText', () => {
    expect(plainText(msg('x', '<p>Hi&nbsp;<b>team</b> &amp; all</p>'))).toBe('Hi team & all');
    expect(plainText(msg('x', '<p>please <a href="https://gitlab.example.com/g/p/-/merge_requests/7">this MR</a></p>'))).toBe('please this MR https://gitlab.example.com/g/p/-/merge_requests/7');
    expect(plainText(msg('x', '<at id="0">Dat</at> review giúp em'))).toBe('Dat review giúp em');
  });

  // ciel/ciel_test.go:69, plus the detector assertions of TestParseInboxSample and TestParseRealInboxFile (ciel_test.go:270, 734)
  it('TestIsCandidate', () => {
    const d = testDetector();
    const system = { ...msg('x', 'renamed chat'), messageType: 'systemEventMessage' };
    const cases: Array<[string, ChatMessage, boolean]> = [
      ['explicit mention', msg('colleague', '<at>X</at> pls check', 'me-id'), true],
      ['mention of someone else', msg('colleague', '<at>Y</at> pls check', 'other-id'), false],
      ['MR link', msg('colleague', 'https://gitlab.example.com/g/p/-/merge_requests/12'), true],
      ['alias with diacritics', msg('colleague', 'Anh Đạt ơi xem giúp em'), true],
      ['unrelated', msg('colleague', 'lunch at 12?'), false],
      ['my own message', msg('me-id', 'https://gitlab.example.com/g/p/-/merge_requests/12'), false],
      ['system event', system, false],
    ];
    for (const [name, m, want] of cases) expect(d.isCandidate(m, plainText(m)), name).toBe(want);
    const sample = parseInboxFile(fixture('inbox-sample.json')).message;
    expect(d.mentionsMe(sample)).toBe(true);
    expect(d.isCandidate(sample, plainText(sample))).toBe(true);
    const real = parseInboxFile(fixture('inbox-real-text.json')).message;
    expect(plainText(real)).toBe('Oke lát a gửi');
    expect(d.isCandidate(real, plainText(real))).toBe(false);
  });

  // ciel/ciel_test.go:95
  it('TestValidMRURLs', () => {
    const d = testDetector();
    const earlier = msg('colleague', 'MR here: https://gitlab.example.com/g/p/-/merge_requests/5');
    const current = msg('colleague', 'anh review giúp em cái trên nhé');
    const got = d.validMRURLs(['https://gitlab.example.com/g/p/-/merge_requests/5.', 'https://gitlab.example.com/g/p/-/merge_requests/5', 'https://gitlab.example.com/g/p/-/merge_requests/999', 'https://evil.example.org/x/-/merge_requests/5'], [earlier], current);
    expect(got).toEqual(['https://gitlab.example.com/g/p/-/merge_requests/5']);
  });

  // ciel/ciel_test.go:250
  it('TestClassifyErrors', async () => {
    const d = testDetector();
    const m = msg('colleague', 'anh Dat ơi');
    const cases: Array<[string, RunResult | Error, string]> = [
      ['command fails', new Error('session failed: Claude Code process exited with code 1'), 'claude session failed'],
      ['reported error', { ...decision({}), isError: true, text: 'Not logged in', structured: undefined }, 'classify returned no decision'],
      ['no decision', { ...decision({}), text: 'hi', structured: undefined }, 'classify returned no decision'],
      ['not a decision', decision({ hello: 'world' }), 'classify returned no decision'],
      ['timed out', new Error('timed out after 180000 ms'), 'classify timed out'],
    ];
    for (const [name, result, reason] of cases) {
      const err = await d.classify([], m, session(result)).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(ClassifyError);
      expect((err as ClassifyError).reason, name).toBe(reason);
    }
  });

  // ciel/kbquery_test.go:16
  it('TestKBQueryQuestion', () => {
    const d = testDetector();
    const cases: Array<[string, ChatMessage, string, boolean]> = [
      ['mention and token', msg('colleague', '<at id="0">X</at> kb_query how does past segment work?', 'me-id'), 'how does past segment work?', true],
      ['alias and token', msg('colleague', 'Dat kb_query what calls pusher?'), 'what calls pusher?', true],
      ['token is case-insensitive', msg('colleague', 'anh Đạt KB_QUERY: trace email flow'), 'trace email flow', true],
      ['keeps line breaks', msg('colleague', 'Dat kb_query line one<br>line two'), 'line one\nline two', true],
      ['no question', msg('colleague', 'Dat kb_query', 'me-id'), '', true],
      ['question only before the token', msg('colleague', 'how does pusher retry? Dat kb_query'), '', true],
      ['no token', msg('colleague', '<at>X</at> how does past segment work?', 'me-id'), '', false],
      ['token inside a word', msg('colleague', 'Dat kb_queryx foo'), '', false],
      ['not addressed', msg('colleague', 'kb_query how does past segment work?'), '', false],
      ['mention of someone else', msg('colleague', '<at>Y</at> kb_query foo', 'other-id'), '', false],
      ['alias inside a word', msg('colleague', 'update kb_query foo'), '', false],
      ['alias only in a link target', msg('colleague', '<a href="https://x.example/dat/1">link</a> kb_query foo'), '', false],
    ];
    for (const [name, m, want, ok] of cases) expect(d.kbQueryQuestion(m), name).toEqual([want, ok]);
  });

  // ciel/ciel_test.go:216 TestClassifyRunsClaudeCode
  it('TestClassifyUsesClassifierProfile', async () => {
    const d = testDetector();
    const inputs: RunInput[] = [];
    const m = msg('colleague', '<at id="0">Dat</at> review giúp em https://gitlab.example.com/g/p/-/merge_requests/5', 'me-id');
    const dec = await d.classify([], m, session(decision({ addressed_to_me: true, intent: 'review_mr', mr_urls: ['https://gitlab.example.com/g/p/-/merge_requests/5'], summary: 'review MR' }), inputs));
    expect(dec).toEqual({ addressedToMe: true, intent: 'review_mr', mrUrls: ['https://gitlab.example.com/g/p/-/merge_requests/5'], summary: 'review MR' });
    const options = inputs[0]?.options;
    expect(options?.disallowedTools).toEqual(CLASSIFY_DENIED_TOOLS);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.persistSession).toBe(false);
    expect(options?.model).toBe('claude-opus-5-5');
    expect(options?.effort).toBe('low');
    expect(options?.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(JSON.stringify(options?.systemPrompt)).toContain('You triage Microsoft Teams');
    expect(options?.tools).toBeUndefined();
    expect(options?.settingSources).toBeUndefined();
    const prompt = inputs[0]?.prompt ?? '';
    expect(prompt).toContain('[this message @mentions the user]');
    expect(prompt).toContain('[person-collea]');
    expect(prompt).not.toContain('colleague');
  });

  it('TestMcpReadTokenTrigger', () => {
    const cfg = testConfig({ teams: { aliases: ['Dat'] }, mcpRead: { name: 'grafana', trigger: 'grafana_query', mcp: ['grafana'], tools: ['query_prometheus'] } });
    const triggers = triggersOf(cfg);
    expect(triggers).toEqual([{ capability: 'kb_query', token: 'kb_query' }, { capability: 'grafana', token: 'grafana_query' }]);
    const d = testDetector();
    expect(d.capabilityToken(triggers, msg('colleague', 'Dat grafana_query: error rate of pusher?'))).toEqual({ capability: 'grafana', question: 'error rate of pusher?' });
    expect(d.capabilityToken(triggers, msg('colleague', '<at>X</at> GRAFANA_QUERY p99 latency', 'me-id'))).toEqual({ capability: 'grafana', question: 'p99 latency' });
    expect(d.capabilityToken(triggers, msg('colleague', 'Dat grafana_queryx foo'))).toBeUndefined();
    expect(d.capabilityToken(triggers, msg('colleague', 'grafana_query not addressed'))).toBeUndefined();
    expect(d.capabilityToken(triggers, msg('colleague', 'Dat kb_query still works'))).toEqual({ capability: 'kb_query', question: 'still works' });
  });

  it('triggers iam_trace on its fixed word', () => {
    const triggers = triggersOf(testConfig({ teams: { aliases: ['Dat'] }, iamTrace: {} }));
    expect(triggers).toContainEqual({ capability: 'iam_trace', token: 'iam_trace' });
    expect(triggersOf(testConfig()).map((t) => t.token)).not.toContain('iam_trace');
    const d = testDetector();
    expect(d.capabilityToken(triggers, msg('colleague', 'Dat iam_trace 123 u1, u2 25/10 09:30'))).toEqual({ capability: 'iam_trace', question: '123 u1, u2 25/10 09:30' });
    expect(d.capabilityToken(triggers, msg('colleague', 'iam_trace 123 u1 not addressed'))).toBeUndefined();
  });
});
