import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkQuote, resolveCite, type ResolvedCite } from '../../src/capability/kb-evidence.js';
import { GATHER_SCHEMA, parseGather } from '../../src/capability/kb-gather.js';
import { gatherPrompt } from '../../src/capability/kb-query.js';
import type { KbPaths } from '../../src/fence/profiles.js';
import type { RunResult } from '../../src/runner/run.js';

const source = Array.from({ length: 30 }, (_, i) => `\tfunc step${i + 1}() { return checkFrequencyLimit(player${i + 1}) }`).join('\n') + '\n';
const doc = '# IAM frequency\n\nA popup is shown at most three times a day to the same player.\n';
const result = (structured: unknown, isError = false): RunResult => ({ isError, text: '', structured, costUsd: 0.01, turns: 2, sessionId: 's', denials: [], toolUses: [], durationMs: 5 });
const entry = { id: 'E1', kind: 'src', cite: 'portal-service/x.go:10-11', quote: 'q'.repeat(30), about: 'what it shows' };
const gathered = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ status: 'done', topic: 'IAM frequency', lang: 'en', ledger: [entry], notes: [], missing: [], ...over });

describe('kb_query gather ledger', () => {
  let paths: KbPaths;
  let src: ResolvedCite;
  let kb: ResolvedCite;
  beforeEach(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'audee-gather-')));
    mkdirSync(join(root, 'portal-service'));
    mkdirSync(join(root, 'wiki/explanatory'), { recursive: true });
    writeFileSync(join(root, 'portal-service/x.go'), source);
    writeFileSync(join(root, 'wiki/explanatory/iam.md'), doc);
    paths = { wiki: join(root, 'wiki'), querySkill: '', scoutSkill: '', repos: [join(root, 'portal-service')] };
    src = resolveCite('src', 'portal-service/x.go:10-11', paths)!;
    kb = resolveCite('kb', 'explanatory/iam.md', paths)!;
  });

  it('accepts a quote copied from the cited lines, whatever its indentation', () => {
    const exact = source.split('\n').slice(9, 11).join('\n');
    expect(checkQuote(src, exact)).toBe(true);
    expect(checkQuote(src, exact.replaceAll('\t', '    '))).toBe(true);
  });

  it('refuses a quote outside the range, a paraphrase and a short quote', () => {
    expect(checkQuote(src, source.split('\n')[14]!)).toBe(false); // line 15, 4 lines past the range
    expect(checkQuote(src, source.split('\n')[13]!)).toBe(true); // line 14, inside the slack
    expect(checkQuote(src, 'step10 checks the frequency limit of the player')).toBe(false);
    expect(checkQuote(src, 'func step10')).toBe(false);
  });

  it('accepts a doc quote anywhere in the doc', () => {
    expect(checkQuote(kb, 'A popup is shown at most three times a day to the same player.')).toBe(true);
  });

  it('parses a ledger and refuses extra fields, a failed session and an error', () => {
    expect(parseGather(result(gathered())).ledger).toEqual([entry]);
    expect(() => parseGather(result(gathered({ ledger: [{ ...entry, extra: 1 }] })))).toThrow('gather returned no ledger');
    expect(() => parseGather(result(gathered({ status: 'failed' })))).toThrow('gather session could not finish');
    expect(() => parseGather(result(gathered(), true))).toThrow('gather reported an error');
  });

  it('enforces the limits the schema only describes', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ ...entry, id: `E${i + 1}` }));
    many[0] = { ...entry, quote: 'x'.repeat(1201) };
    many[1] = { ...entry, about: 'x'.repeat(201) };
    const ledger = parseGather(result(gathered({ ledger: many }))).ledger;
    expect(ledger).toHaveLength(38);
    expect(ledger[0]?.id).toBe('E3');
    expect(GATHER_SCHEMA['additionalProperties']).toBe(false);
  });

  it('asks for evidence, not an answer, under the same overrides', () => {
    const p = gatherPrompt('/kb', paths, false);
    for (const want of ['Do not write an answer', 'copied exactly from the cited place', 'Never ask a question', 'never call kb-enrich', 'Never quote credentials', paths.repos[0]!]) expect(p).toContain(want);
  });
});
