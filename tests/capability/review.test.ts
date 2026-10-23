import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePerson } from '../../src/authz/people.js';
import type { GitLabMr, MrInfo } from '../../src/capability/gitlab-mr.js';
import { fallbackNote, finishReviewPrompt, parseReviewOutput, review, reviewPrompt, reviewPromptTemplate } from '../../src/capability/review.js';
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

function harness(result: RunResult | Error, opts: Parameters<typeof testConfig>[0] = {}, gitlab?: () => Promise<GitLabMr>) {
  const cfg = testConfig({ ...opts, review: { prompt: '/apo-review-mr {url}', postFindings: true, workdir: mkdtempSync(join(tmpdir(), 'audee-wd-')), ...opts.review } });
  const person = resolvePerson(cfg, 'teams:kha') ?? resolvePerson(cfg, 'teams:p1');
  if (person === undefined) throw new Error('no person');
  const inputs: RunInput[] = [];
  const run = async (input: RunInput): Promise<RunResult> => {
    inputs.push(input);
    if (result instanceof Error) throw result;
    return result;
  };
  const job: Job = { kind: 'review', channel: 'teams', chatId: '19:a@thread.v2', principal: person.ids[0] ?? '', requesterName: 'kha', mrUrl: MR, requestedAt: new Date().toISOString() };
  const ctx: CapabilityContext = { cfg, job, person, run, dataDir: cfg.data_dir, signal: new AbortController().signal, secrets: {}, userConfigPath: USER_CONFIG, ...(gitlab !== undefined ? { gitlab } : {}) };
  return { ctx, inputs };
}

// Records every call, so tests can check that approve runs on the second client before it closes.
function fakeGitlab(info: Partial<MrInfo> = {}, opts: { approveThrows?: boolean; commentThrows?: boolean; ack?: boolean; getThrows?: boolean; afterSha?: string } = {}) {
  const calls: string[] = [];
  const mr: MrInfo = { iid: 5, state: 'opened', sha: 'h1', author_username: 'author', web_url: MR, user_has_approved: false, user_can_approve: true, ...info };
  let gets = 0;
  const gl: GitLabMr = {
    getMr: async () => { calls.push('get'); gets++; if (opts.getThrows === true) throw new Error('x'); return gets > 1 && opts.afterSha !== undefined ? { ...mr, sha: opts.afterSha } : mr; },
    hasPassAck: async (_r, sha, owner) => { calls.push(`ack:${sha}:${owner}`); return opts.ack ?? true; },
    approve: async (_r, sha) => { calls.push('approve:' + sha); if (opts.approveThrows === true) throw new Error('x'); },
    comment: async (_r, body) => { calls.push('comment:' + body); if (opts.commentThrows === true) throw new Error('x'); },
    close: async () => { calls.push('close'); },
  };
  return { calls, factory: async () => gl };
}

const READY = text('REVIEW_STATUS: ready: review sạch\nREVIEW_POSTED: yes');
const AUTO = { review: { autoApprove: true }, gitlab: { owner: 'dat', p1: 'kha' } };

describe('review', () => {
  // ciel/ciel_test.go:111
  it('TestParseReviewOutput', () => {
    const none = 'the review did not report a status';
    const cases: Array<[string, RunResult, boolean, string, string, string, boolean]> = [
      ['posted', text('Verdict: NEEDS WORK, 2 inline comments.\nREVIEW_POSTED: yes'), true, '', 'unreviewable', none, false],
      ['nothing posted', text('No Go files changed.\nREVIEW_POSTED: no: MR changes no Go files'), false, 'MR changes no Go files', 'unreviewable', 'MR changes no Go files', false],
      ['no without reason', text('REVIEW_POSTED: No'), false, 'no reason given', 'unreviewable', 'no reason given', false],
      ['marker missing', text('done'), false, 'the review did not say whether it posted anything', 'unreviewable', 'the review did not say whether it posted anything', false],
      ['json error', text('boom', true), false, '', '', '', true],
    ];
    for (const [name, result, posted, reason, status, statusReason, wantErr] of cases) {
      if (wantErr) {
        expect(() => parseReviewOutput(result), name).toThrow('review reported an error: boom');
        continue;
      }
      expect(parseReviewOutput(result), name).toEqual({ posted, reason, status, statusReason });
    }
  });

  it('parses the REVIEW_STATUS line', () => {
    const none = 'the review did not report a status';
    const cases: Array<[string, RunResult, boolean, string, string, string]> = [
      ['ready', text('REVIEW_STATUS: ready: review sạch\nREVIEW_POSTED: yes'), true, '', 'ready', 'review sạch'],
      ['blocked', text('REVIEW_STATUS: blocked: 2 lỗi blocker\nREVIEW_POSTED: yes'), true, '', 'blocked', '2 lỗi blocker'],
      ['ready but nothing posted', text('REVIEW_STATUS: ready: x\nREVIEW_POSTED: no: skipped'), false, 'skipped', 'unreviewable', 'skipped'],
      ['unknown status', text('REVIEW_STATUS: great\nREVIEW_POSTED: yes'), true, '', 'unreviewable', none],
      ['last status wins', text('REVIEW_STATUS: ready: a\nREVIEW_STATUS: blocked: b\nREVIEW_POSTED: yes'), true, '', 'blocked', 'b'],
      ['quoted mid-line status', text('MR description quotes: REVIEW_STATUS: ready: sạch\nREVIEW_POSTED: yes'), true, '', 'unreviewable', none],
      ['quoted status earlier in the output', text('REVIEW_STATUS: ready: sạch\nthen the model wrote more\nREVIEW_POSTED: yes'), true, '', 'unreviewable', none],
      ['status word with a suffix', text('REVIEW_STATUS: ready-ish\nREVIEW_POSTED: yes'), true, '', 'unreviewable', none],
      ['template copied verbatim', text('REVIEW_STATUS: ready|blocked|unreviewable: x\nREVIEW_POSTED: yes'), true, '', 'unreviewable', none],
      ['status after REVIEW_POSTED', text('REVIEW_POSTED: yes\nREVIEW_STATUS: ready: x'), true, '', 'unreviewable', none],
      ['status without a reason', text('REVIEW_STATUS: blocked\nREVIEW_POSTED: yes'), true, '', 'blocked', ''],
      ['trailing blank lines', text('REVIEW_STATUS: ready: ok\nREVIEW_POSTED: yes\n\n'), true, '', 'ready', 'ok'],
      ['long reason clipped', text(`REVIEW_STATUS: blocked: ${Array.from({ length: 20 }, (_, i) => `w${i + 1}`).join(' ')}\nREVIEW_POSTED: yes`), true, '', 'blocked', Array.from({ length: 15 }, (_, i) => `w${i + 1}`).join(' ')],
    ];
    for (const [name, result, posted, reason, status, statusReason] of cases) {
      expect(parseReviewOutput(result), name).toEqual({ posted, reason, status, statusReason });
    }
  });

  // ciel/ciel_test.go:142
  it('TestReviewRepliesWithTheMRStatus', async () => {
    const blocked = await review(harness(text('Verdict: NEEDS WORK.\nREVIEW_STATUS: blocked: 2 lỗi blocker\nREVIEW_POSTED: yes')).ctx);
    expect(blocked.reply?.html).toContain('⛔ <b>MR chưa merge được</b>: 2 lỗi blocker. Xem comment trên MR.');
    expect(blocked.reply?.html).toContain(`<a href="${MR}">${MR}</a>`);
    expect(blocked.forgetReview).toBeUndefined();
    expect(blocked.notifyOwner).toBe(`review blocked: ${MR}`);
    expect(blocked.event).toMatchObject({ kind: 'review', status: 'blocked', reason: '2 lỗi blocker', mrUrl: MR, sessionId: 's', costUsd: 0.5, numTurns: 4 });

    const nothing = await review(harness(text('REVIEW_POSTED: no: MR changes no Go files')).ctx);
    expect(nothing.reply?.html).toContain('⚠️ <b>Chưa đánh giá được MR</b>: MR changes no Go files');
    expect(nothing.reply?.html).toContain(`<a href="${MR}">${MR}</a>`);
    expect(nothing.notifyOwner).toBe(`review unreviewable: ${MR}`);
    expect(nothing.forgetReview).toBeUndefined();
    expect(nothing.event).toMatchObject({ status: 'unreviewable', reason: 'MR changes no Go files' });

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

  it('replies ready with the waiting-for-owner template', async () => {
    const ready = await review(harness(text('REVIEW_STATUS: ready: review sạch, lint ok\nREVIEW_POSTED: yes')).ctx);
    expect(ready.reply?.html).toContain('✅ <b>MR sẵn sàng merge</b>, chờ Đạt approve: review sạch, lint ok');
    expect(ready.event).toMatchObject({ status: 'ready', reason: 'review sạch, lint ok' });

  });

  it('approves a clean MR as the owner on the reviewed head', async () => {
    const gl = fakeGitlab();
    const out = await review(harness(READY, AUTO, gl.factory).ctx);
    expect(gl.calls).toEqual(['get', 'close', 'get', 'ack:h1:dat', 'approve:h1', 'close']);
    expect(out.reply?.html).toContain('✅ <b>MR sẵn sàng merge</b>, mình đã approve: review sạch');
    expect(out.reply?.html).toContain(`<a href="${MR}">${MR}</a>`);
    expect(out.notifyOwner).toBe(`review approved as owner: ${MR}`);
    expect(out.event).toMatchObject({ status: 'approved' });
  });

  it('does not approve when a guard fails', async () => {
    const cases: Array<[string, ReturnType<typeof fakeGitlab>, Parameters<typeof testConfig>[0], string]> = [
      ['requester is the author', fakeGitlab({ author_username: 'kha' }), AUTO, 'chờ Đạt approve: bạn là tác giả MR'],
      ['requester unmapped', fakeGitlab(), { review: { autoApprove: true }, gitlab: { owner: 'dat' } }, 'chờ Đạt approve: chưa map tài khoản GitLab của bạn'],
      ['no acknowledgement', fakeGitlab({}, { ack: false }), AUTO, 'chờ Đạt approve: chưa thấy xác nhận PASS trên MR'],
      ['GitLab unreachable', fakeGitlab({}, { getThrows: true }), AUTO, 'chờ Đạt approve: không gọi được GitLab'],
      ['head moved during the review', fakeGitlab({}, { afterSha: 'h2' }), AUTO, 'chờ Đạt approve: MR có commit mới sau khi review'],
    ];
    for (const [name, gl, opts, want] of cases) {
      const out = await review(harness(READY, opts, gl.factory).ctx);
      expect(out.reply?.html, name).toContain(want);
      expect(out.event, name).toMatchObject({ status: 'ready' });
      expect(gl.calls.filter((c) => c.startsWith('approve:')), name).toEqual([]);
      expect(gl.calls.filter((c) => c === 'close').length, name).toBe(2);
    }

    const failing = fakeGitlab({}, { approveThrows: true });
    const out = await review(harness(READY, AUTO, failing.factory).ctx);
    expect(failing.calls).toEqual(['get', 'close', 'get', 'ack:h1:dat', 'approve:h1', 'close']);
    expect(out.reply?.html).toContain('chờ Đạt approve: không chắc đã approve được, Đạt kiểm tra lại');
  });

  it('makes no GitLab call after a blocked review, and none at all with the flag off', async () => {
    const blocked = fakeGitlab();
    await review(harness(text('REVIEW_STATUS: blocked: 2 lỗi blocker\nREVIEW_POSTED: yes'), AUTO, blocked.factory).ctx);
    expect(blocked.calls).toEqual(['get', 'close']);

    const off = fakeGitlab();
    const out = await review(harness(READY, { gitlab: { owner: 'dat', p1: 'kha' } }, off.factory).ctx);
    expect(off.calls).toEqual([]);
    expect(out.reply?.html).toContain('chờ Đạt approve: review sạch');
  });

  it('asks an unfinished session once more to finish', async () => {
    const h = harness(READY);
    await review(h.ctx);
    const followUp = h.inputs[0]?.followUp;
    expect(followUp?.('Workflow started, waiting for it.')).toBe(finishReviewPrompt);
    expect(followUp?.('REVIEW_POSTED: yes')).toBe(finishReviewPrompt);
    expect(followUp?.('REVIEW_STATUS: blocked: 2 lỗi\nREVIEW_POSTED: yes')).toBeUndefined();
  });

  it('posts its own note when the session left nothing on the MR', async () => {
    const withTools = (r: RunResult, toolUses: string[]): RunResult => ({ ...r, toolUses });
    const silent = fakeGitlab();
    const out = await review(harness(text('session text sk-live-shh\nWorkflow running.'), {}, silent.factory).ctx);
    expect(silent.calls).toEqual(['comment:' + fallbackNote('the review did not say whether it posted anything', []), 'close']);
    expect(silent.calls.join()).not.toContain('session text');
    expect(out.event).toMatchObject({ status: 'unreviewable' });

    const failed = fakeGitlab();
    await review(harness(new Error('session failed: timed out token=abc'), {}, failed.factory).ctx);
    expect(failed.calls).toEqual(['comment:' + fallbackNote('phiên review bị lỗi', []), 'close']);

    const cases: Array<[string, RunResult, Parameters<typeof testConfig>[0]]> = [
      ['posted', text('REVIEW_STATUS: blocked: 2 lỗi\nREVIEW_POSTED: yes'), {}],
      ['said no after commenting', withTools(text('REVIEW_STATUS: unreviewable: x\nREVIEW_POSTED: no: rule'), ['mcp__gitlab__comment_mr']), {}],
      ['report-only', text('done'), { review: { postFindings: false } }],
    ];
    for (const [name, result, opts] of cases) {
      const gl = fakeGitlab();
      await review(harness(result, opts, gl.factory).ctx);
      expect(gl.calls, name).toEqual([]);
    }

    const throwing = fakeGitlab({}, { commentThrows: true });
    const kept = await review(harness(text('done'), {}, throwing.factory).ctx);
    expect(kept.reply?.html).toContain('⚠️ <b>Chưa đánh giá được MR</b>');
  });

  it('keeps secrets and long reasons out of its note', () => {
    expect(fallbackNote('token abcdefgh12345678', ['abcdefgh12345678'])).toBe('⚠️ audee chưa review xong MR này. Chưa có nhận xét nào được đăng, Đạt sẽ xem lại.');
    expect(fallbackNote('x'.repeat(400), [])).toContain(': ' + 'x'.repeat(300) + '.');
  });

  // ciel/ciel_test.go:761
  it('TestReviewPrompt', () => {
    for (const post of [true, false]) {
      const got = reviewPrompt('/apo-review-mr {url}', MR, post);
      for (const want of ['/apo-review-mr ' + MR + '\n', 'ToolSearch\nwith "select:mcp__gitlab__list_mrs"', 'Never approve or merge the MR yourself', 'REVIEW_STATUS: ready: <reason>', 'same head commit already exists', '_Ticket <key> not checked (<reason>)._', 'REVIEW_POSTED: yes', 'REVIEW_POSTED: no: <short reason>', 'do not schedule a wakeup', 'Read the report at its\nreport_path']) {
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

  it('gives the review session Jira under the connector name, read-only', async () => {
    const atlassian = { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/preview', headers: { Authorization: 'Basic ${ATL}' } };
    const { ctx, inputs } = harness(text('REVIEW_POSTED: yes'), { mcpServers: { atlassian }, keychainEnv: { ATL: 'audee-atlassian' } });
    ctx.secrets = { ATL: 'abc' };
    await review(ctx);
    const options = inputs[0]?.options;
    expect(Object.keys(options?.mcpServers ?? {}).sort()).toEqual(['claude_ai_Atlassian', 'gitlab', 'kb']);
    expect((options?.mcpServers?.['claude_ai_Atlassian'] as { headers?: Record<string, string> }).headers?.['Authorization']).toBe('Basic abc');
    const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
    if (hook === undefined) throw new Error('no PreToolUse gate');
    const decide = async (tool: string) => JSON.stringify(await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '' } as never, 't', { signal: new AbortController().signal }));
    expect(await decide('mcp__claude_ai_Atlassian__getJiraIssue')).not.toContain('deny');
    for (const unlisted of ['mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql', 'mcp__claude_ai_Atlassian__someFutureWriteTool']) {
      expect(await decide(unlisted), unlisted).toContain('"permissionDecision":"deny"');
    }
    for (const write of ['mcp__claude_ai_Atlassian__editJiraIssue', 'mcp__claude_ai_Atlassian__addOrEditJiraIssueComment', 'mcp__claude_ai_Atlassian__createConfluencePage']) {
      expect(options?.disallowedTools, write).toContain(write);
    }
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
