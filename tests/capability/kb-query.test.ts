import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePerson } from '../../src/authz/people.js';
import { kbQuery, kbQueryDir, kbQueryDirs, kbQueryPrompt, setKbRefSync } from '../../src/capability/kb-query.js';
import { KB_TECH_SCHEMA } from '../../src/capability/kb-tech-schema.js';
import type { CapabilityContext } from '../../src/capability/types.js';
import { KB_QUERY_TOOLS } from '../../src/fence/constants.js';
import type { Job } from '../../src/queue/job.js';
import { kbQueryFailedReply, kbQueryFileReply, kbQueryWithheldReply, maxKBAnswerFileChars, maxReplyChars } from '../../src/render/html.js';
import { InterruptedError, type RunInput, type RunResult } from '../../src/runner/run.js';
import { testConfig } from '../helpers/test-config.js';

const USER_CONFIG = fileURLToPath(new URL('../fixtures/claude-user-config.json', import.meta.url));

// ciel/kbquery_test.go:70 testKB: a KB whose kb-query skill sits behind a symlink, with the given checkouts.
function testKB(...services: string[]): string {
  const kb = join(mkdtempSync(join(tmpdir(), 'audee-kb-')), 'kb');
  for (const d of ['kb-mcp/wiki', '.claude/skills/kb-scout', '../agents/kb-query']) mkdirSync(join(kb, d), { recursive: true, mode: 0o700 });
  symlinkSync('../../../agents/kb-query', join(kb, '.claude/skills/kb-query'));
  let repos = '';
  for (const s of services) {
    mkdirSync(join(kb, '.kb-ref-worktrees', s), { recursive: true, mode: 0o700 });
    writeFileSync(join(kb, '.kb-ref-worktrees', s, 'main.go'), Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
    repos += `  - path: ../${s}\n    name: ${s}\n`;
  }
  writeFileSync(join(kb, 'kb.yaml'), `wiki_dir: ./kb-mcp/wiki\nrepos:\n${repos}ref_policy:\n  worktree_root: .kb-ref-worktrees\n`);
  writeFileSync(join(kb, 'INTERSERVICE.md'), '# services');
  return kb;
}

const CITE = 'pusher/main.go:10';

// A tech answer (KB_TECH_SCHEMA) whose text is split into cited blocks of at most 1500 characters, 20 to a section.
function techAnswer(text: string, o: { topic?: string; status?: string } = {}): Record<string, unknown> {
  const chunks = text === '' ? [] : (text.match(/[\s\S]{1,1500}/gu) ?? []);
  const sections = [];
  for (let i = 0; i < chunks.length; i += 20) sections.push({ heading: 'Answer', blocks: chunks.slice(i, i + 20).map((c) => ({ kind: 'text', text: c, cites: [CITE] })) });
  return { status: o.status ?? 'done', topic: o.topic ?? '', lang: 'vi', title: 'Answer', sections, notes: [], missing: [] };
}

const done = (answer: string, o: { topic?: string; status?: string } = {}): RunResult => ({ isError: false, text: '', structured: techAnswer(answer, o), costUsd: 0.1, turns: 3, sessionId: 's1', denials: [], toolUses: ['Read'], durationMs: 10 });

function harness(kb: string, result: RunResult | Error, principal = 'teams:owner') {
  const cfg = testConfig({ kbDir: kb });
  const person = resolvePerson(cfg, principal);
  if (person === undefined) throw new Error('no person');
  const inputs: RunInput[] = [];
  const run = async (input: RunInput): Promise<RunResult> => {
    inputs.push(input);
    if (result instanceof Error) throw result;
    return result;
  };
  const job: Job = { kind: 'kb_query', channel: 'teams', chatId: 'chat', principal, requesterName: 'linh', messageId: '1791513774214', input: 'past segment hoạt động thế nào?', requestedAt: new Date().toISOString() };
  const ctx: CapabilityContext = { cfg, job, person, run, dataDir: cfg.data_dir, signal: new AbortController().signal, secrets: {}, userConfigPath: USER_CONFIG };
  return { ctx, inputs, dir: kbQueryDir(cfg.data_dir, '1791513774214') };
}

describe('kb_query', () => {
  let synced = 0;
  beforeEach(() => {
    synced = 0;
    setKbRefSync(async () => { synced++; });
  });
  afterEach(() => setKbRefSync(async () => {}));

  // ciel/kbquery_test.go:167
  it('TestKBQueryDirsReadsKBRepos', () => {
    const kb = testKB('pusher');
    const paths = kbQueryDirs(kb);
    const real = (p: string): string => realpathSync(p);
    expect(paths.querySkill).toBe(real(join(dirname(kb), 'agents', 'kb-query')));
    expect([paths.wiki, paths.querySkill, paths.scoutSkill]).toEqual([real(join(kb, 'kb-mcp/wiki')), paths.querySkill, real(join(kb, '.claude/skills/kb-scout'))]);
    expect(paths.repos).toEqual([real(join(kb, '.kb-ref-worktrees/pusher'))]);
    expect(kbQueryPrompt(kb, paths, true)).toContain(paths.querySkill + ' (SKILL.md');
  });

  // ciel/kbquery_test.go:191
  it('TestKBQueryDirsRefusesBadCheckouts', () => {
    const cases: Record<string, (kb: string) => void> = {
      'missing checkout': (kb) => writeFileSync(join(kb, 'kb.yaml'), 'ref_policy:\n  worktree_root: .kb-ref-worktrees\nrepos:\n  - name: gone\n'),
      'name escapes the checkouts': (kb) => writeFileSync(join(kb, 'kb.yaml'), 'ref_policy:\n  worktree_root: .kb-ref-worktrees\nrepos:\n  - name: ../escape\n'),
      'checkout root is the KB itself': (kb) => writeFileSync(join(kb, 'kb.yaml'), 'ref_policy:\n  worktree_root: .\n'),
      'wiki links out of the KB': (kb) => { rmSync(join(kb, 'kb-mcp', 'wiki'), { recursive: true }); symlinkSync(mkdtempSync(join(tmpdir(), 'outside-')), join(kb, 'kb-mcp', 'wiki')); },
      'checkout root outside the KB': (kb) => writeFileSync(join(kb, 'kb.yaml'), 'ref_policy:\n  worktree_root: ../elsewhere\n'),
      'checkout links to a working tree': (kb) => { symlinkSync(mkdtempSync(join(tmpdir(), 'work-')), join(kb, '.kb-ref-worktrees', 'linked')); writeFileSync(join(kb, 'kb.yaml'), 'ref_policy:\n  worktree_root: .kb-ref-worktrees\nrepos:\n  - name: linked\n'); },
    };
    for (const [name, setup] of Object.entries(cases)) {
      const kb = testKB();
      mkdirSync(join(kb, '.kb-ref-worktrees'), { recursive: true, mode: 0o700 });
      writeFileSync(join(kb, 'kb.yaml'), 'ref_policy:\n  worktree_root: .kb-ref-worktrees\n');
      setup(kb);
      expect(() => kbQueryDirs(kb), name).toThrow();
    }
  });

  it('TestHandleKBQuerySendsAnswerAsHtmlFile', async () => {
    const { ctx, inputs, dir } = harness(testKB('pusher'), done('<script>x</script> & co, see https://evil.example/x'));
    const outcome = await kbQuery(ctx);
    expect(outcome.reply?.html).toBe(kbQueryFileReply + '<br><i>Về: past segment hoạt động thế nào?</i>');
    const file = outcome.reply?.file;
    expect(file?.name).toMatch(/^kb-answer-1791513774214-\d{8}-\d{6}\.html$/);
    const page = file?.content ?? '';
    for (const want of ['<h2>Answer</h2>', '&lt;script&gt;x&lt;/script&gt; &amp; co', 'hxxps://evil.example/x', '<li>pusher/main.go:10-10</li>', 'past segment hoạt động thế nào?']) expect(page).toContain(want);
    expect(page).not.toContain('<script');
    expect(synced).toBe(1);
    const input = inputs[0];
    expect(input?.options.extraArgs).toEqual({ restricted: null });
    expect(input?.prompt).toContain('./question.txt');
    expect(input?.prompt).toContain('INTERSERVICE.md is ./INTERSERVICE.md');
    expect(input?.options.cwd).toBe(dir);
    expect(readFileSync(join(dir, 'question.txt'), 'utf8')).toBe(ctx.job.input);
    expect(outcome.removeAfterReply).toBe(dir); // the watcher deletes it once the reply is delivered
    expect(outcome.event).toMatchObject({ kind: 'kb_query', status: 'done', sessionId: 's1', costUsd: 0.1, numTurns: 3, toolUses: ['Read'], itemsKept: 1, itemsRemoved: 0 });
    expect(outcome.notifyOwner).toBeUndefined();
  });

  // ciel/kbquery_test.go:289: the tech schema has no need_input, so such an answer breaks the contract.
  it('TestHandleKBQueryKeepsFolderWhenInputNeeded', async () => {
    const result: RunResult = { ...done(''), structured: { ...techAnswer(''), status: 'need_input', missing: ['Which <service>? see HTTPS://evil.example'] } };
    const { ctx, dir } = harness(testKB('pusher'), result);
    const outcome = await kbQuery(ctx);
    expect(outcome.event).toMatchObject({ status: 'failed', reason: 'answer does not match the contract' });
    expect(outcome.reply?.file).toBeUndefined();
    expect(outcome.removeAfterReply).toBeUndefined();
    expect(readFileSync(join(dir, 'question.txt'), 'utf8')).toBe(ctx.job.input);
    expect(readFileSync(join(dir, 'INTERSERVICE.md'), 'utf8')).toBe('# services');
    expect(existsSync(join(dir, 'output.json'))).toBe(true);
  });

  // ciel/kbquery_test.go:305
  it('TestHandleKBQueryFailure', async () => {
    const cases: Record<string, RunResult | Error> = {
      'failed status': { ...done(''), structured: { ...techAnswer('', { status: 'failed' }), notes: ['denied'] } },
      'old answer shape': { ...done(''), structured: { status: 'done', answer: 'x', sources: [], notes: [], missing: [] } },
      'no structure': { ...done(''), structured: undefined, text: 'hi' },
      'claude error': { ...done(''), isError: true, structured: undefined },
      'need_input empty': { ...done(''), structured: { ...techAnswer(''), status: 'need_input' } },
      'session failed': new Error('session failed: Claude Code process exited with code 1'),
      'timed out': new Error('timed out after 900000 ms'),
    };
    for (const [name, result] of Object.entries(cases)) {
      const { ctx, dir } = harness(testKB('pusher'), result);
      const outcome = await kbQuery(ctx);
      expect(outcome.reply?.html, name).toBe(kbQueryFailedReply);
      expect(outcome.notifyOwner, name).toContain('kb_query failed');
      expect(outcome.event.status, name).toBe('failed');
      expect(existsSync(join(dir, 'output.json')), name).toBe(true);
      expect(outcome.removeAfterReply, name).toBeUndefined();
    }
  });

  // ciel/kbquery_test.go:344
  it('TestHandleKBQueryWithholdsSecrets', async () => {
    const answers: Record<string, string> = {
      'private key': '-----BEGIN RSA PRIVATE KEY-----',
      'uri password': 'mongo at mongodb://app:hunter2hunter@10.0.0.1:27017',
      'key value': 'set api_key: "abcd1234efgh5678"',
      'token prefix': 'use glpat-abcdefghijklmnopqrst',
    };
    for (const [name, answer] of Object.entries(answers)) {
      const { ctx, dir } = harness(testKB('pusher'), done(answer));
      const outcome = await kbQuery(ctx);
      expect(outcome.reply?.html, name).toBe(kbQueryWithheldReply);
      expect(outcome.reply?.file, name).toBeUndefined();
      expect(outcome.event.status, name).toBe('withheld');
      expect(outcome.notifyOwner, name).toContain('withheld');
      expect(existsSync(join(dir, 'output.json')), name).toBe(true);
    }
  });

  it('kb_query file reply carries the session topic', async () => {
    const result = done('Past segment', { topic: 'past segment tính audience' });
    const { ctx } = harness(testKB('pusher'), result);
    const outcome = await kbQuery(ctx);
    expect(outcome.reply?.html).toBe(kbQueryFileReply + '<br><i>Về: past segment tính audience</i>');
    expect(outcome.reply?.file).toBeDefined();
  });

  it('kb_query withholds an answer whose topic looks like a credential', async () => {
    const result = done('safe answer', { topic: 'use glpat-abcdefghijklmnopqrst' });
    const { ctx } = harness(testKB('pusher'), result);
    const outcome = await kbQuery(ctx);
    expect(outcome.reply?.html).toBe(kbQueryWithheldReply);
    expect(outcome.reply?.file).toBeUndefined();

    const known = done('safe answer', { topic: 'about s3cr3t-value-123' });
    const second = harness(testKB('pusher'), known);
    second.ctx.secrets = { GL_TOKEN: 's3cr3t-value-123' };
    const withheld = await kbQuery(second.ctx);
    expect(withheld.reply?.html).toBe(kbQueryWithheldReply);
  });

  it('answers a tech question not_known when the model found nothing or no block survives', async () => {
    const empty = await kbQuery(harness(testKB('pusher'), done('')).ctx);
    expect(empty.event).toMatchObject({ status: 'not_known', reason: 'model found no evidence', itemsKept: 0 });
    const bad = done('claims');
    ((bad.structured as { sections: Array<{ blocks: Array<{ cites: string[] }> }> }).sections[0]!.blocks[0]!).cites = ['pusher/none.go:1'];
    const out = await kbQuery(harness(testKB('pusher'), bad).ctx);
    expect(out.event).toMatchObject({ status: 'not_known', reason: 'no claim survived the evidence check', itemsKept: 0, itemsRemoved: 1 });
    expect(out.reply?.file).toBeUndefined();
  });

  it('TestHandleKBQuerySendsLongAnswerWhole', async () => {
    const { ctx, dir } = harness(testKB('pusher'), done('y'.repeat(maxReplyChars)));
    const outcome = await kbQuery(ctx);
    const page = outcome.reply?.file?.content ?? '';
    expect(page.match(/y/gu)?.length).toBeGreaterThanOrEqual(maxReplyChars);
    expect(page).not.toContain('cắt bớt');
    expect(outcome.removeAfterReply).toBe(dir);
  });

  it('TestHandleKBQueryClipsHugeAnswerFile', async () => {
    const { ctx, dir } = harness(testKB('pusher'), done('y'.repeat(maxKBAnswerFileChars + 10)));
    const outcome = await kbQuery(ctx);
    const page = outcome.reply?.file?.content ?? '';
    expect(page).toContain('cắt bớt');
    expect(page).not.toContain('y'.repeat(maxKBAnswerFileChars + 1));
    expect(existsSync(join(dir, 'result.json'))).toBe(true);
    expect(outcome.removeAfterReply).toBeUndefined();
  });

  // Markdown can hide a credential from a check on the source: what the reader sees is checked too.
  it('TestHandleKBQueryWithholdsSecretsHiddenByMarkdown', async () => {
    const known = 'Zq9-known-SECRET-value';
    const answers: Record<string, string> = {
      'bold key': '**password**: hunter2hunter2',
      'code key': '`password`: hunter2hunter2',
      'bold key, code value': '- **DB password**: `hunter2hunter2`',
      'split token': 'AKIA**IOSF**ODNN7EXAMPLE',
      'table': '| key | value |\n|---|---|\n| password | hunter2hunter2 |',
      'known, split by code': 'Zq9-`known`-SECRET-value',
      'header names the column': '| user | password |\n|---|---|\n| bob | hunter2hunter2 |',
      'single column': '| password |\n|---|\n| hunter2hunter2 |',
    };
    for (const [name, answer] of Object.entries(answers)) {
      const { ctx } = harness(testKB('pusher'), done(answer));
      ctx.secrets = { DB: known };
      const outcome = await kbQuery(ctx);
      expect(outcome.reply?.html, name).toBe(kbQueryWithheldReply);
      expect(outcome.reply?.file, name).toBeUndefined();
      expect(outcome.event.status, name).toBe('withheld');
    }
    for (const literal of ['&#65;KIAIOSFODNN7EXAMPLE', 'Zq9\\-known-SECRET-value']) {
      const { ctx } = harness(testKB('pusher'), done(literal));
      const page = (await kbQuery(ctx)).reply?.file?.content ?? '';
      expect(page, literal).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(page, literal).not.toContain(known);
    }
  });

  // ciel/kbquery_test.go:438
  it('TestKBQueryPromptOverridesSkill', () => {
    const paths = { wiki: '/kb/kb-mcp/wiki', querySkill: '/kb/.agents/skills/kb-query', scoutSkill: '/kb/.agents/skills/kb-scout', repos: ['/kb/.kb-ref-worktrees/pusher'] };
    const p = kbQueryPrompt('/kb', paths, true);
    for (const want of ['/kb/.agents/skills/kb-query', '/kb/.agents/skills/kb-scout/SKILL.md', '/kb/kb-mcp/wiki', '/kb/.kb-ref-worktrees/pusher', './question.txt', 'Never ask a question', 'never ask the requester to clarify', 'answer every one', 'overview of what the KB covers', 'Leave "missing" empty', 'at most 12 words', 'a Vietnamese\nquestion gets a Vietnamese topic', 'Luồng set up lucky wheel', 'run no script', 'never call kb-enrich', 'Never quote credentials', 'INTERSERVICE.md is ./INTERSERVICE.md', 'Markdown inline formatting', 'Code is never\ntyped', '--full and --code-flow']) {
      expect(p).toContain(want);
    }
    expect(kbQueryPrompt('/kb', paths, false)).not.toContain('INTERSERVICE.md');
    expect(p).not.toContain('need_input');
  });

  it('keeps a product answer in product mode whatever the question looks like', () => {
    const paths = { wiki: '/kb/kb-mcp/wiki', querySkill: '/kb/.agents/skills/kb-query', scoutSkill: '/kb/.agents/skills/kb-scout', repos: ['/kb/.kb-ref-worktrees/pusher'] };
    const rule = '"mode" must be "product" and "answer" must be "" whatever the question looks like';
    expect(kbQueryPrompt('/kb', paths, false, 'product')).toContain(rule);
    expect(kbQueryPrompt('/kb', paths, false, 'tech')).not.toContain(rule);
  });

  it('asks for checkable cites and allows a product answer to abstain', () => {
    const paths = { wiki: '/kb/kb-mcp/wiki', querySkill: '/kb/.agents/skills/kb-query', scoutSkill: '/kb/.agents/skills/kb-scout', repos: ['/kb/.kb-ref-worktrees/pusher'] };
    const cite = "<service>/<path>:<line> or <service>/<path>:<from>-<to>, where <service> is the checkout's folder name";
    const abstain = 'If neither the KB\n  nor the source covers the question, return no readings and say in "missing" what you could not find.';
    const removed = 'audee removes\n"unverified" items and any item whose cite does not resolve';
    const product = kbQueryPrompt('/kb', paths, false, 'product');
    for (const want of [cite, abstain, removed]) expect(product).toContain(want);
    expect(product).not.toContain('Leave "missing" empty');
    const tech = kbQueryPrompt('/kb', paths, false, 'tech');
    expect(tech).toContain(cite);
    expect(tech).not.toContain(abstain);
  });

  it('kb_query cannot ask the requester back', () => {
    const status = (KB_TECH_SCHEMA['properties'] as Record<string, { enum?: string[] }>)['status'];
    expect(status?.enum).toEqual(['done', 'failed']);
  });

  it('TestKBQueryUsesKbReadProfile', async () => {
    const { ctx, inputs } = harness(testKB('pusher'), done('ok'), 'teams:p1');
    await kbQuery(ctx);
    const input = inputs[0];
    expect(input?.options.extraArgs).toEqual({ restricted: null });
    expect(input?.options.allowedTools).toEqual(KB_QUERY_TOOLS);
    expect(input?.options.permissionMode).toBe('dontAsk');
    expect(input?.auth).toBe('api_key'); // a teammate
    expect(input?.apiKeyItem).toBe('audee-anthropic');
    expect(input?.timeoutMs).toBe(15 * 60_000);
    expect(input?.signal).toBe(ctx.signal);
    const owner = harness(testKB('pusher'), done('ok'));
    await kbQuery(owner.ctx);
    expect(owner.inputs[0]?.auth).toBe('subscription');
    const interrupted = new InterruptedError();
    await expect(kbQuery(harness(testKB('pusher'), interrupted).ctx)).rejects.toBe(interrupted);
  });
});
