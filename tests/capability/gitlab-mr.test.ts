import { describe, expect, it } from 'vitest';
import { approvalDecision, type MrInfo, mrRef, noteHasPassAck } from '../../src/capability/gitlab-mr.js';

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
});
