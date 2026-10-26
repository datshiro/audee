import { describe, expect, it } from 'vitest';
import type { CheckedPoint, IamTraceRequest, MergedTrace, TraceResult } from '../../src/capability/iam-trace-schema.js';
import { answerPageVisibleTexts, checkAnswerPage, emptyText, failedText, iamTraceFailedReply, iamTraceMissingReply, iamTraceQueuedReply, iamTraceUsageReply, kbQueryEmptyReply, queuedText } from '../../src/render/html.js';
import { iamTraceFileName, iamTraceNotice, iamTracePage, iamTraceTexts } from '../../src/render/iam-trace-page.js';
import { leaksSecret } from '../../src/render/secrets.js';

const REQ: IamTraceRequest = { target: 'C1', users: ['u1', 'r2'], since: '24h', window: '24 giờ gần nhất' };
const point = (over: Partial<CheckedPoint> & Pick<CheckedPoint, 'kind' | 'state'>): CheckedPoint => ({ label: '', time: '', source_field: '', evidence: '', why: '', ref: 'u1-p1', check: 'unverified', ...over });
// send comes before check_call so the time sort is exercised; trigger and check_call share an instant and keep their order.
const TRACE: MergedTrace = {
  finding: 'IAM đã gửi cho u1 <b>ok</b>.',
  notes: ['ghi chú <i>một</i>'],
  verified: true,
  counts: { confirmed: 2, corrected: 1, unverified: 3 },
  users: [
    {
      id: 'u1',
      user_id: 'u1',
      role_id: '',
      points: [
        point({ kind: 'trigger', state: 'seen', check: 'confirmed', label: 'trigger fired', time: '2026-10-25T01:00:00.000Z', source_field: '_time', evidence: '<script>alert(1)</script> https://evil.example/x' }),
        point({ kind: 'send', state: 'seen', check: 'corrected', label: 'push sent', time: '1792890123123', source_field: 'campaignInfo.sourceTimestamp', evidence: 'push accepted' }),
        point({ kind: 'check_call', state: 'inferred', label: 'check call', why: 'worker lines lost after wait', time: '1792890000000', source_field: 'ts' }),
        point({ kind: 'sdk_event', state: 'seen', check: 'confirmed', label: 'open', time: '1792890130', source_field: 'ts', evidence: 'sdk event open' }),
        point({ kind: 'inbox', state: 'not_recorded', label: 'inbox' }),
      ],
    },
    { id: 'r2', user_id: '', role_id: 'r2', points: [point({ kind: 'delivered', state: 'inferred', label: 'ack', why: 'ack not found', time: 'soon', ref: 'u2-p1' })] },
  ],
};
const between = (s: string, from: string, to: string): string => {
  const i = s.indexOf(from);
  return s.slice(i, s.indexOf(to, i));
};

describe('iam_trace replies', () => {
  it('queued, failed and empty replies are keyed by kind', () => {
    expect(queuedText('iam_trace')).toBe(iamTraceQueuedReply);
    expect(failedText('iam_trace')).toBe(iamTraceFailedReply);
    expect(emptyText('iam_trace')).toBe(iamTraceUsageReply);
    expect(emptyText('kb_query')).toBe(kbQueryEmptyReply);
    expect(emptyText('grafana')).toBe(kbQueryEmptyReply);
  });

  it('the usage reply says users are comma-separated', () => {
    expect(iamTraceUsageReply).toContain('cách nhau bằng dấu phẩy');
  });

  it('the missing reply escapes and defangs each item and ends with the usage', () => {
    const reply = iamTraceMissingReply(['mã "a<b>" không hợp lệ', 'xem https://x.example']);
    expect(reply).toContain('&lt;b&gt;');
    expect(reply).toContain('hxxps://x.example');
    expect(reply).not.toContain('https://');
    expect(reply).toContain(iamTraceUsageReply);
  });
});

describe('iam trace page', () => {
  const page = iamTracePage(REQ, TRACE);

  it('passes the page check with the exact CSP and stays inert', () => {
    expect(checkAnswerPage(page)).toBeUndefined();
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
    expect(page).not.toContain('<script');
    expect(page).toContain('&lt;script&gt;');
    expect(page).not.toContain('<b>');
    expect(page).toContain('hxxps://evil.example/x');
    expect(page).not.toContain('https://evil.example');
    expect(leaksSecret(answerPageVisibleTexts(page), [])).toBe(false);
  });

  it('says what was not checked and never claims a point did not happen', () => {
    expect(page).toContain('Temporal không kiểm tra');
    expect(page).toContain('không ghi nhận');
    expect(page).not.toContain('không xảy ra');
    expect(page).not.toContain('18 phút');
    expect(page).not.toContain('Bộ lọc thời gian');
  });

  it('puts the server row above the client row and sorts each row by time', () => {
    const u1 = between(page, '<section>', '</section>');
    expect(u1.indexOf('class="tl server"')).toBeGreaterThan(-1);
    expect(u1.indexOf('class="tl server"')).toBeLessThan(u1.indexOf('class="tl client"'));
    const server = between(u1, 'class="tl server"', '</ol>');
    expect(server.indexOf('trigger fired')).toBeGreaterThan(-1);
    expect(server.indexOf('trigger fired')).toBeLessThan(server.indexOf('check call'));
    expect(server.indexOf('check call')).toBeLessThan(server.indexOf('push sent'));
    expect(server).not.toContain('open');
    expect(between(u1, 'class="tl client"', '</ol>')).toContain('open');
  });

  it('shows times in ICT, flags store time, inferred points and corrections', () => {
    expect(page).toContain('≈ 25/10 08:00:00');
    expect(page).toContain('giờ kho log');
    expect(page).toContain('<span class="t">25/10 08:02:03.123</span>');
    expect(page).toContain('<span class="t">25/10 08:02:10</span>');
    expect(page).toContain('<span class="t">?</span>');
    expect(page).toContain('<span class="t">—</span>');
    expect(page).toContain('check call *');
    expect(page).toContain('worker lines lost after wait');
    expect(page).toContain('đã sửa khi kiểm chứng');
    expect(page).toContain('ghi chú &lt;i&gt;một&lt;/i&gt;');
  });

  it('says how the points were verified', () => {
    expect(page).toContain('Đã kiểm chứng độc lập bằng một phiên truy vấn lại: 2 mốc khớp, 1 mốc đã sửa, 3 mốc chưa kiểm chứng.');
    const unverified = iamTracePage(REQ, { ...TRACE, verified: false });
    expect(checkAnswerPage(unverified)).toBeUndefined();
    expect(unverified).toContain('Chưa kiểm chứng độc lập.');
    expect(unverified).not.toContain('Đã kiểm chứng độc lập');
    expect(iamTracePage(REQ, { ...TRACE, verified: false, reason: 'verifier checked no point' })).toContain('Chưa kiểm chứng độc lập: phiên kiểm chứng không kiểm lại được mốc nào.');
    expect(iamTracePage(REQ, { ...TRACE, verified: false, reason: 'verifier changed most points' })).toContain('Chưa kiểm chứng độc lập: phiên kiểm chứng sửa quá nửa số mốc nên các chỉnh sửa không được áp dụng.');
    const other = iamTracePage(REQ, { ...TRACE, verified: false, reason: 'boom <x>' });
    expect(other).toContain('Chưa kiểm chứng độc lập: kết quả kiểm chứng không dùng được.');
    expect(other).not.toContain('boom');
  });

  it('flags an unverified time filter', () => {
    expect(iamTracePage({ ...REQ, timeFilter: '_time:(a, b)' }, TRACE)).toContain('Bộ lọc thời gian _time chưa được xác minh');
  });

  it('clips evidence and renders an empty row', () => {
    const long: MergedTrace = { ...TRACE, users: [{ id: 'u1', user_id: 'u1', role_id: '', points: [point({ kind: 'send', state: 'seen', evidence: 'x'.repeat(700), time: '1792890123123' })] }] };
    const p = iamTracePage(REQ, long);
    expect(checkAnswerPage(p)).toBeUndefined();
    expect(p).toContain('x'.repeat(600) + '…');
    expect(p).not.toContain('x'.repeat(601));
    expect(between(p, 'class="tl client"', '</ol>')).toContain('không ghi nhận mốc nào');
  });

  it('leaves a secret visible to the secret check', () => {
    const leaky: MergedTrace = { ...TRACE, users: [{ id: 'u1', user_id: 'u1', role_id: '', points: [point({ kind: 'send', state: 'seen', evidence: 'key glsa_abcdefghijklmnopqrstuvwxyz' })] }] };
    expect(leaksSecret(answerPageVisibleTexts(iamTracePage(REQ, leaky)))).toBe(true);
  });

  it('iamTraceTexts reads every string of a trace or a merged trace', () => {
    const texts = iamTraceTexts(TRACE);
    for (const u of TRACE.users) for (const p of u.points) expect(texts).toContain(p.evidence);
    expect(texts).toContain('push sent: push accepted');
    expect(texts).toContain(TRACE.finding);
    const raw: TraceResult = { status: 'done', finding: 'f', missing: [], notes: [], users: [{ id: 'u1', user_id: 'u1', role_id: '', points: [{ kind: 'send', label: 'token', time: '', source_field: '', evidence: 'abcdefghijkl12', state: 'seen', why: '' }] }] };
    expect(iamTraceTexts(raw)).toContain('token: abcdefghijkl12');
    expect(leaksSecret(iamTraceTexts(raw))).toBe(true);
  });

  it('the notice counts points and says what was not checked', () => {
    const notice = iamTraceNotice(REQ, TRACE);
    expect(notice).toContain('2 user · 3 mốc ghi nhận · 2 mốc suy ra · 1 mốc không ghi nhận');
    expect(notice).toContain('1 mốc đã sửa khi kiểm chứng');
    expect(notice).toContain('3 mốc chưa kiểm chứng');
    expect(notice).toContain('Temporal không kiểm tra');
    expect(notice).toContain('24 giờ gần nhất');
    expect(notice).toContain('&lt;b&gt;ok&lt;/b&gt;');
    expect(notice).not.toContain('<script');
    expect(notice).not.toContain('chưa kiểm chứng độc lập');
    const unverified = iamTraceNotice(REQ, { ...TRACE, verified: false, reason: 'verifier checked no point', counts: { confirmed: 0, corrected: 0, unverified: 6 } });
    expect(unverified).toContain('6 mốc chưa kiểm chứng');
    expect(unverified).toContain('chưa kiểm chứng độc lập (phiên kiểm chứng không kiểm lại được mốc nào)');
    expect(unverified).not.toContain('đã sửa');
  });

  it('file name carries the message id and a UTC stamp', () => {
    expect(iamTraceFileName('1791513774214', new Date(Date.UTC(2026, 9, 25, 1, 2, 3)))).toBe('iam-trace-1791513774214-20261025-010203.html');
  });
});
