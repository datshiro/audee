import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePerson } from '../../src/authz/people.js';
import { parseReviewOutput, review, reviewPrompt, reviewPromptTemplate } from '../../src/capability/review.js';
import type { CapabilityContext } from '../../src/capability/types.js';
import { loadConfig } from '../../src/config/load.js';
import { REVIEW_DENIED_TOOLS } from '../../src/fence/constants.js';
import type { Job } from '../../src/queue/job.js';
import { failedReply } from '../../src/render/html.js';
import { InterruptedError, type RunInput, type RunResult } from '../../src/runner/run.js';
import { testConfig } from '../helpers/test-config.js';

const USER_CONFIG = fileURLToPath(new URL('../fixtures/claude-user-config.json', import.meta.url));
const MR = 'https://gitlab.example.com/g/p/-/merge_requests/5';

const text = (result: string, isError = false): RunResult => ({ isError, text: result, sessionId: 's', costUsd: 0.5, turns: 4, denials: [], toolUses: ['mcp__gitlab__list_mrs'], durationMs: 1 });

function harness(result: RunResult | Error, opts: Parameters<typeof testConfig>[0] = {}) {
  const cfg = testConfig({ review: { prompt: '/apo-review-mr {url}', postFindings: true, workdir: mkdtempSync(join(tmpdir(), 'audee-wd-')) }, ...opts });
  const person = resolvePerson(cfg, 'teams:kha') ?? resolvePerson(cfg, 'teams:p1');
  if (person === undefined) throw new Error('no person');
  const inputs: RunInput[] = [];
  const run = async (input: RunInput): Promise<RunResult> => {
    inputs.push(input);
    if (result instanceof Error) throw result;
    return result;
  };
  const job: Job = { kind: 'review', channel: 'teams', chatId: '19:a@thread.v2', principal: person.ids[0] ?? '', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() };
  const ctx: CapabilityContext = { cfg, job, person, run, dataDir: cfg.data_dir, signal: new AbortController().signal, secrets: {}, userConfigPath: USER_CONFIG };
  return { ctx, inputs };
}

describe('review', () => {
  // ciel/ciel_test.go:111
  it('TestParseReviewOutput', () => {
    const cases: Array<[string, RunResult, boolean, string, boolean]> = [
      ['posted', text('Verdict: NEEDS WORK, 2 inline comments.\nREVIEW_POSTED: yes'), true, '', false],
      ['nothing posted', text('No Go files changed.\nREVIEW_POSTED: no: MR changes no Go files'), false, 'MR changes no Go files', false],
      ['no without reason', text('REVIEW_POSTED: No'), false, 'no reason given', false],
      ['marker missing', text('done'), false, 'the review did not say whether it posted anything', false],
      ['json error', text('boom', true), false, '', true],
    ];
    for (const [name, result, posted, reason, wantErr] of cases) {
      if (wantErr) {
        expect(() => parseReviewOutput(result), name).toThrow('review reported an error: boom');
        continue;
      }
      expect(parseReviewOutput(result), name).toEqual({ posted, reason });
    }
  });

  // ciel/ciel_test.go:142
  it('TestReviewRepliesOnlyWhenSomethingWasPosted', async () => {
    const posted = await review(harness(text('Verdict: NEEDS WORK.\nREVIEW_POSTED: yes')).ctx);
    expect(posted.reply?.html).toContain('Đã review xong MR này');
    expect(posted.reply?.html).toContain(`<a href="${MR}">${MR}</a>`);
    expect(posted.forgetReview).toBeUndefined();
    expect(posted.event).toMatchObject({ kind: 'review', status: 'posted', mrUrl: MR, sessionId: 's', costUsd: 0.5, numTurns: 4 });

    const nothing = await review(harness(text('REVIEW_POSTED: no: MR changes no Go files')).ctx);
    expect(nothing.reply?.html).toContain('không post comment nào.</b> Lý do: MR changes no Go files');
    expect(nothing.reply?.html).toContain(`<a href="${MR}">${MR}</a>`);
    expect(nothing.notifyOwner).toContain('MR changes no Go files');
    expect(nothing.forgetReview).toBeUndefined();
    expect(nothing.event).toMatchObject({ status: 'nothing', reason: 'MR changes no Go files' });

    const failed = await review(harness(new Error('session failed: Claude Code process exited with code 1')).ctx);
    expect(failed.reply?.html).toContain(failedReply);
    expect(failed.reply?.html).toContain(MR);
    expect(failed.forgetReview).toBe(MR);
    expect(failed.event).toMatchObject({ status: 'failed' });

    const errored = await review(harness(text('boom', true)).ctx);
    expect(errored.forgetReview).toBe(MR);
    expect(errored.event).toMatchObject({ status: 'failed', reason: 'review reported an error: boom' });

    const interrupted = new InterruptedError();
    await expect(review(harness(interrupted).ctx)).rejects.toBe(interrupted);
  });

  // ciel/ciel_test.go:761
  it('TestReviewPrompt', () => {
    for (const post of [true, false]) {
      const got = reviewPrompt('/apo-review-mr {url}', MR, post);
      for (const want of ['/apo-review-mr ' + MR + '\n', 'ToolSearch\nwith "select:mcp__gitlab__list_mrs"', 'Never approve or merge', '_Ticket <key> not checked (<reason>)._', 'REVIEW_POSTED: yes', 'REVIEW_POSTED: no: <short reason>']) {
        expect(got, `post=${post}`).toContain(want);
      }
      const posts = got.includes('the answer is "Post review comments on the MR"');
      const reportOnly = got.includes('the answer is "Leave it report-only"');
      const inline = got.includes('inline diff comment on its\nfile and line') && got.includes('mcp__gitlab__comment_mr');
      expect(posts, `post=${post}`).toBe(post);
      expect(reportOnly, `post=${post}`).toBe(!post);
      expect(inline, `post=${post}`).toBe(post);
      expect(got.includes('still post one short comment'), `post=${post}`).toBe(post);
    }
  });

  // ciel/ciel_test.go:973
  it('TestReviewRoutes', () => {
    const cfg = testConfig({ review: { prompt: '/apo-review-mr {url}', routes: [{ match: 'gitlab\\.gt\\.vng\\.vn/apollo/automation-collection/', prompt: 'Reality Checker reviews {url}' }] } });
    const cap = cfg.capabilities['review'];
    if (cap === undefined) throw new Error('no review capability');
    for (const [url, want] of [
      ['https://gitlab.gt.vng.vn/apollo/automation-collection/-/merge_requests/12', 'Reality Checker reviews {url}'],
      ['https://gitlab.gt.vng.vn/apollo/portal-service/-/merge_requests/3', '/apo-review-mr {url}'],
      ['https://gitlab.gt.vng.vn/common/gobase-library/-/merge_requests/141', '/apo-review-mr {url}'],
    ]) {
      expect(reviewPromptTemplate(cap, url ?? ''), url).toBe(want);
    }
    const bad = join(mkdtempSync(join(tmpdir(), 'audee-cfg-')), 'config.yaml');
    writeFileSync(bad, `data_dir: /tmp/x
concurrency: { max_concurrent: 1, lanes: { heavy: { concurrency: 1 } } }
people: [{ name: dat, owner: true, ids: ["teams:o"], can: ["*"] }]
channels: { teams: { onedrive_dir: /tmp/x, chats: ["19:a@thread.v2"] } }
capabilities:
  review: { profile: review, lane: heavy, routes: [{ match: "(", prompt: x }] }
`);
    expect(() => loadConfig(bad)).toThrow('routes[0].match');
  });

  it('TestReviewUsesReviewProfile', async () => {
    const { ctx, inputs } = harness(text('REVIEW_POSTED: yes'));
    await review(ctx);
    const options = inputs[0]?.options;
    expect(options?.permissionMode).toBe('auto');
    expect(options?.persistSession).toBe(false);
    for (const denied of REVIEW_DENIED_TOOLS) expect(options?.disallowedTools, denied).toContain(denied);
    expect(options?.settingSources).toEqual(['user', 'project', 'local']);
    expect(Object.keys(options?.mcpServers ?? {}).sort()).toEqual(['gitlab', 'kb']);
    expect(options?.cwd).toBe(ctx.cfg.capabilities['review']?.workdir);
    expect(inputs[0]?.prompt.startsWith('/apo-review-mr ' + MR)).toBe(true);
    expect(inputs[0]?.timeoutMs).toBe(45 * 60_000);
    expect(inputs[0]?.auth).toBe('api_key');
  });
});
