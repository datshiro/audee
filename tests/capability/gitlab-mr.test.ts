import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { approvalDecision, connectGitLabMr, type MrInfo, mrRef, noteHasPassAck } from '../../src/capability/gitlab-mr.js';

const FAKE_SERVER = fileURLToPath(new URL('../fixtures/fake-glab-mcp.mjs', import.meta.url));

// A ~/.claude.json whose gitlab server is the fake glab-mcp; returns it and the call log path.
function fakeServerConfig(mode: 'ok' | 'error') {
  const dir = mkdtempSync(join(tmpdir(), 'audee-glab-'));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  const userConfigPath = join(dir, 'claude.json');
  writeFileSync(userConfigPath, JSON.stringify({ mcpServers: { gitlab: { command: process.execPath, args: [FAKE_SERVER], env: { FAKE_GLAB_LOG: log, FAKE_GLAB_MODE: mode } } } }));
  const calls = (): Array<{ name: string; args: Record<string, unknown> }> => readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  return { userConfigPath, calls };
}

const mr = (o: Partial<MrInfo> = {}): MrInfo => ({ iid: 5, state: 'opened', sha: 'h1', author_username: 'author', web_url: 'u', user_has_approved: false, user_can_approve: true, ...o });

describe('gitlab-mr', () => {
  it('parses a merge request URL', () => {
    expect(mrRef('https://gitlab.example.com/g/sub/p/-/merge_requests/5')).toEqual({ project: 'g/sub/p', iid: 5 });
    expect(mrRef('https://gitlab.example.com/g/p/-/merge_requests/12/diffs')).toEqual({ project: 'g/p', iid: 12 });
    expect(() => mrRef('https://gitlab.example.com/g/p/-/issues/5')).toThrow();
  });

  it('approves only when every condition holds, and names the first one that fails', () => {
    const ok = { autoApprove: true, status: 'ready', before: mr(), after: mr(), ackFound: true, requesterGitlab: 'kha', ownerGitlab: 'dat', statusReason: 'review sạch' };
    const cases: Array<[string, Parameters<typeof approvalDecision>[0], string]> = [
      ['flag off', { ...ok, autoApprove: false }, 'review sạch'],
      ['not ready', { ...ok, status: 'blocked' }, 'review sạch'],
      ['before missing', { ...ok, before: undefined }, 'không gọi được GitLab'],
      ['after missing', { ...ok, after: undefined }, 'không gọi được GitLab'],
      ['merged', { ...ok, after: mr({ state: 'merged' }) }, 'MR không còn mở'],
      ['head moved', { ...ok, after: mr({ sha: 'h2' }) }, 'MR có commit mới sau khi review'],
      ['owner unmapped', { ...ok, ownerGitlab: undefined }, 'chưa map tài khoản GitLab của Đạt'],
      ['no acknowledgement', { ...ok, ackFound: false }, 'chưa thấy xác nhận PASS trên MR'],
      ['requester unmapped', { ...ok, requesterGitlab: undefined }, 'chưa map tài khoản GitLab của bạn'],
      ['requester is the author', { ...ok, requesterGitlab: 'Author' }, 'bạn là tác giả MR'],
      ['owner is the author', { ...ok, ownerGitlab: 'AUTHOR' }, 'MR của Đạt, cần người khác approve'],
      ['cannot approve', { ...ok, after: mr({ user_can_approve: false }) }, 'tài khoản Đạt không approve được MR này'],
      ['already approved', { ...ok, after: mr({ user_has_approved: true }) }, 'Đạt đã approve trước đó'],
    ];
    for (const [name, input, why] of cases) expect(approvalDecision(input), name).toEqual({ approve: false, why });
    expect(approvalDecision(ok)).toEqual({ approve: true, sha: 'h1' });
  });

  it('accepts only the owner\'s PASS acknowledgement for this head', () => {
    const sha = '0123456789abcdef';
    const body = '## Apollo MR Review — automated ✅\n\n**Verdict: PASS — no confirmed findings** (head `0123456789`, base `aaaaaaaaaa` = main)';
    expect(noteHasPassAck({ body, author: { username: 'Dat' } }, sha, 'dat')).toBe(true);
    expect(noteHasPassAck({ body, author: { username: 'author' } }, sha, 'dat')).toBe(false);
    expect(noteHasPassAck({ body: body.replace('0123456789', '9999999999'), author: { username: 'dat' } }, sha, 'dat')).toBe(false);
    expect(noteHasPassAck({ body: body.replace('Verdict: PASS', 'Verdict: NEEDS WORK'), author: { username: 'dat' } }, sha, 'dat')).toBe(false);
    expect(noteHasPassAck({ author: { username: 'dat' } }, sha, 'dat')).toBe(false);
  });

  it('talks to the gitlab MCP server: reads the MR, pages discussions for the ack, approves with the sha', async () => {
    const fake = fakeServerConfig('ok');
    const gl = await connectGitLabMr({}, fake.userConfigPath);
    try {
      const ref = { project: 'g/p', iid: 5 };
      const mr = await gl.getMr(ref);
      expect(mr).toMatchObject({ iid: 5, sha: '0123456789abcdef', author_username: 'author', user_can_approve: true });
      expect(await gl.hasPassAck(ref, mr.sha, 'dat')).toBe(true);
      expect(await gl.hasPassAck(ref, mr.sha, 'kha')).toBe(false);
      await gl.approve(ref, mr.sha);
    } finally {
      await gl.close();
    }
    const calls = fake.calls();
    expect(calls.map((c) => c.name)).toEqual(['get_mr', 'list_mr_discussions', 'list_mr_discussions', 'list_mr_discussions', 'list_mr_discussions', 'approve_mr']);
    expect(calls.filter((c) => c.name === 'list_mr_discussions').map((c) => c.args['page'])).toEqual([1, 2, 1, 2]);
    expect(calls.at(-1)?.args).toEqual({ project_id: 'g/p', mr_iid: 5, sha: '0123456789abcdef' });
  });

  it('turns a tool error into an error that does not carry the tool text', async () => {
    const fake = fakeServerConfig('error');
    const gl = await connectGitLabMr({}, fake.userConfigPath);
    try {
      const err = await gl.getMr({ project: 'g/p', iid: 5 }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('get_mr failed');
      await expect(gl.approve({ project: 'g/p', iid: 5 }, 'abc')).rejects.toThrow('approve_mr failed');
    } finally {
      await gl.close();
    }
  });
});
