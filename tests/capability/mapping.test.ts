import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePerson } from '../../src/authz/people.js';
import { expireScratchDirs, mapping, mappingDir, mappingPrompt, parseMappingOutput, probeTmpDir, setPruneProbeWorktrees } from '../../src/capability/mapping.js';
import type { CapabilityContext } from '../../src/capability/types.js';
import type { Job } from '../../src/queue/job.js';
import { mappingFailedReply, mappingMissingReply, mappingTooLongReply, maxReplyChars } from '../../src/render/html.js';
import type { RunInput, RunResult } from '../../src/runner/run.js';
import { testConfig } from '../helpers/test-config.js';

const MSG = '1791513774214';
const rawRetentionMs = 3 * 24 * 60 * 60 * 1000;

// ciel/mapping_test.go:69-72
const doneResult = (codeMapping = 'parts[2] >= 1 && x'): RunResult => ({ isError: false, text: 'ok', sessionId: 's', costUsd: 0.7, turns: 9, structured: { status: 'done', codeMapping, sampleMessage: 'a|b', supportedOutputFields: [{ name: 'Level' }], notes: ['RESULT 0 problem'], missing: [] }, denials: [], toolUses: ['Bash'], durationMs: 1 });
const needInputResult: RunResult = { isError: false, text: 'ok', sessionId: 's', structured: { status: 'need_input', notes: [], missing: ['schema'] }, denials: [], toolUses: [], durationMs: 1 };

function skillDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'audee-skill-')), 'es');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), 'skill');
  return dir;
}

function harness(result: RunResult | Error, run?: (input: RunInput) => Promise<RunResult>, skill = skillDir()) {
  const cfg = testConfig({ mapping: { skillDir: skill, prompt: 'Read {skill}/SKILL.md and follow it.' } });
  const person = resolvePerson(cfg, 'teams:p1');
  if (person === undefined) throw new Error('no person');
  const inputs: RunInput[] = [];
  const fake = run ?? (async (input: RunInput): Promise<RunResult> => {
    inputs.push(input);
    if (result instanceof Error) throw result;
    return result;
  });
  const job: Job = { kind: 'code_mapping', channel: 'teams', chatId: 'chat', principal: 'teams:p1', requesterName: 'linh', messageId: MSG, input: 'sample', requestedAt: '2026-10-14T00:00:00.000Z' };
  const ctx: CapabilityContext = { cfg, job, person, run: fake, dataDir: cfg.data_dir, signal: new AbortController().signal, secrets: {} };
  return { ctx, inputs, dir: mappingDir(cfg.data_dir, MSG) };
}

describe('code mapping', () => {
  let pruned = 0;
  beforeEach(() => {
    pruned = 0;
    setPruneProbeWorktrees(() => { pruned++; });
  });
  afterEach(() => setPruneProbeWorktrees(() => {}));

  // ciel/mapping_test.go:49
  it('TestMappingPrompt', () => {
    const p = mappingPrompt('Read {skill}/SKILL.md and follow it.', '/x/skill');
    for (const want of ['./request.txt', 'need_input', '"failed"', 'bash /x/skill/scripts/probe-pipeline.sh ./eventsource.json\n', 'degraded variant in ./eventsource-degraded.json', '" --ref refs/remotes/origin/staging" appended', 'Read /x/skill/SKILL.md', 'mcp__claude_ai_GDS_Connector__gds_liveops___data_contract', '/x/skill/references/multiplexed-topic-guard.md', '/x/skill/ledgers/', 'fqn "kafka-gio.<log name>" and no log']) {
      expect(p).toContain(want);
    }
    for (const placeholder of ['{skill}', '{payload}', '{degraded}', '{cachedRef}']) expect(p).not.toContain(placeholder);
  });

  // ciel/mapping_test.go:75
  it('TestParseMappingOutput', () => {
    const wrap = (structured: unknown): RunResult => ({ isError: false, text: 'r', sessionId: 's', structured, denials: [], toolUses: [], durationMs: 1 });
    const cases: Array<[string, RunResult, boolean]> = [
      ['done', doneResult(), true],
      ['need input', needInputResult, true],
      ['error', { ...wrap(undefined), isError: true, text: 'boom' }, false],
      ['no structured output', wrap(undefined), false],
      ['unknown status', wrap({ status: 'maybe', notes: [], missing: [] }), false],
      ['done without mapping', wrap({ status: 'done', sampleMessage: 'a', supportedOutputFields: [{}], notes: [], missing: [] }), false],
      ['done without sample', wrap({ status: 'done', codeMapping: 'a', supportedOutputFields: [{}], notes: [], missing: [] }), false],
      ['done without fields', wrap({ status: 'done', codeMapping: 'a', sampleMessage: 'a', supportedOutputFields: [], notes: [], missing: [] }), false],
      ['need input without missing', wrap({ status: 'need_input', notes: [], missing: [] }), false],
      ['session failed', wrap({ status: 'failed', notes: ['Bash denied'], missing: [] }), false],
    ];
    for (const [name, result, ok] of cases) {
      if (ok) expect(() => parseMappingOutput(result), name).not.toThrow();
      else expect(() => parseMappingOutput(result), name).toThrow();
    }
  });

  // ciel/mapping_test.go:187
  it('TestRunMappingStartsFresh', async () => {
    let seen: { stale: boolean; request: string } | undefined;
    const probe = async (input: RunInput): Promise<RunResult> => {
      const cwd = input.options.cwd ?? '';
      seen = { stale: existsSync(join(cwd, 'eventsource.json')), request: readFileSync(join(cwd, 'request.txt'), 'utf8') };
      return doneResult();
    };
    const h = harness(doneResult(), probe);
    mkdirSync(h.dir, { recursive: true });
    writeFileSync(join(h.dir, 'eventsource.json'), 'stale');
    await mapping(h.ctx);
    expect(seen).toEqual({ stale: false, request: 'sample' });
  });

  // ciel/mapping_test.go:220
  it('TestHandleMappingRepliesWithPayload', async () => {
    const { ctx, inputs, dir } = harness(doneResult());
    const outcome = await mapping(ctx);
    expect(outcome.reply?.html).toContain('<b>codeMapping</b>');
    expect(outcome.reply?.html).toContain('parts[2] &gt;= 1 &amp;&amp; x');
    expect(inputs[0]?.options.extraArgs).toEqual({ restricted: null });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(probeTmpDir(dir))).toBe(false);
    expect(outcome.event).toMatchObject({ kind: 'code_mapping', status: 'done', sessionId: 's', msgId: MSG });
  });

  // ciel/mapping_test.go:251
  it('TestHandleMappingSendsLongResultAsFile', async () => {
    const long = 'x'.repeat(maxReplyChars);
    const { ctx, dir } = harness(doneResult(long));
    const outcome = await mapping(ctx);
    expect(outcome.reply?.html).toBe(mappingTooLongReply);
    const file = outcome.reply?.file;
    expect(file?.name.startsWith(`codemapping-${MSG}-`)).toBe(true);
    expect(file?.name.endsWith('.json')).toBe(true);
    const content = JSON.parse(file?.content ?? '{}') as { codeMapping?: string; supportedOutputFields?: unknown[]; sampleMessage?: unknown };
    expect(content.codeMapping).toBe(long);
    expect(content.supportedOutputFields).toHaveLength(1);
    expect(content.sampleMessage).toBeUndefined();
    expect(existsSync(join(dir, 'result.json'))).toBe(true);
  });

  // ciel/mapping_test.go:278
  it('TestHandleMappingAsksForMissingInput', async () => {
    const { ctx, dir } = harness(needInputResult);
    const outcome = await mapping(ctx);
    expect(outcome.reply?.html).toContain(mappingMissingReply);
    expect(outcome.reply?.html).toContain('<li>schema</li>');
    expect(existsSync(join(dir, 'output.json'))).toBe(true);
    expect(outcome.event.status).toBe('need_input');
  });

  // ciel/mapping_test.go:291
  it('TestHandleMappingSessionFailedStatus', async () => {
    const { ctx, dir } = harness({ isError: false, text: 'ok', sessionId: 's', structured: { status: 'failed', notes: ['Bash denied'], missing: [] }, denials: [], toolUses: [], durationMs: 1 });
    const outcome = await mapping(ctx);
    expect(outcome.reply?.html).toBe(mappingFailedReply);
    expect(outcome.event.status).toBe('failed');
    expect(outcome.event.reason).not.toContain('Bash denied');
    expect(existsSync(join(dir, 'output.json'))).toBe(true);
  });

  // ciel/mapping_test.go:307
  it('TestHandleMappingFailure', async () => {
    const { ctx, dir } = harness(new Error('session failed: Claude Code process exited with code 1'));
    const outcome = await mapping(ctx);
    expect(outcome.reply?.html).toBe(mappingFailedReply);
    expect(outcome.event).toMatchObject({ kind: 'code_mapping', status: 'failed' });
    expect(outcome.notifyOwner).toContain('code mapping failed');
    expect(pruned).toBe(1);
    expect(readFileSync(join(dir, 'request.txt'), 'utf8')).toBe('sample');
  });

  // ciel/mapping_test.go:325
  it('TestExpireMappingDirs', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'audee-data-'));
    const old = mappingDir(dataDir, '1000000000001');
    const recent = mappingDir(dataDir, '1000000000002');
    for (const d of [old, recent]) mkdirSync(d, { recursive: true });
    const past = new Date(Date.now() - 4 * 24 * 3600_000);
    utimesSync(old, past, past);
    expireScratchDirs(dataDir, new Date(Date.now() - rawRetentionMs));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('TestMappingUsesPinnedRealPath', async () => {
    const real = skillDir();
    const link = join(mkdtempSync(join(tmpdir(), 'audee-link-')), 'es');
    symlinkSync(real, link);
    const { ctx, inputs, dir } = harness(doneResult(), undefined, link);
    await mapping(ctx);
    const resolved = realpathSync(real);
    const input = inputs[0];
    expect(input?.options.additionalDirectories).toEqual([resolved]);
    expect(input?.options.allowedTools).toContain(`Bash(bash ${resolved}/scripts/probe-pipeline.sh ./eventsource.json)`);
    expect(input?.options.disallowedTools).toContain(`Edit(/${resolved}/**)`);
    expect(input?.prompt).toContain(`Read ${resolved}/SKILL.md`);
    expect(input?.tmpdir).toBe(probeTmpDir(dir));
    expect(input?.options.cwd).toBe(dir);
    expect(input?.options.permissionMode).toBe('dontAsk');
  });
});
