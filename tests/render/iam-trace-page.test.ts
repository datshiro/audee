import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckedPoint, IamTraceRequest, MergedTrace, TraceResult } from '../../src/capability/iam-trace-schema.js';
import { answerPageVisibleTexts, checkAnswerPage, emptyText, failedText, iamTraceFailedReply, iamTraceMissingReply, iamTraceQueuedReply, iamTraceUsageReply, kbQueryEmptyReply, queuedText } from '../../src/render/html.js';
import { iamTraceFileName, iamTraceNotice, iamTracePage, iamTraceTexts } from '../../src/render/iam-trace-page.js';
import { leaksSecret } from '../../src/render/secrets.js';
import { PUBLISHED, SAMPLE_REQUEST, SUBSCRIBED_ROLE, sampleTrace } from '../fixtures/iam-trace-sample.js';

const REQ: IamTraceRequest = { target: 'C1', users: ['u1', 'r2'], since: '24h', window: '24 giờ gần nhất' };
const point = (over: Partial<CheckedPoint> & Pick<CheckedPoint, 'kind' | 'state'>): CheckedPoint => ({ label: '', journey: 'J1', outcome: 'info', channel: '', result: '', time: '', source_field: '', evidence: '', why: '', ref: 'u1-p1', check: 'unverified', ...over });
// send comes before check_call so the time sort is exercised; trigger and check_call share an instant and keep their order.
const TRACE: MergedTrace = {
  finding: 'IAM đã gửi cho u1 <b>ok</b>.',
  conclusion: ['kết luận <i>một</i>', 'kết luận hai'],
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
        point({ kind: 'send', state: 'seen', check: 'corrected', outcome: 'pass', label: 'push sent', time: '1792890123123', source_field: 'campaignInfo.sourceTimestamp', evidence: 'push accepted' }),
        point({ kind: 'check_call', state: 'inferred', label: 'check call', why: 'worker lines lost after wait', time: '1792890000000', source_field: 'ts' }),
        point({ kind: 'sdk_event', state: 'seen', check: 'confirmed', journey: '', label: 'open', time: '1792890130', source_field: 'ts', evidence: 'sdk event open' }),
        point({ kind: 'inbox', state: 'not_recorded', journey: '', label: 'inbox' }),
      ],
    },
    { id: 'r2', user_id: '', role_id: 'r2', points: [point({ kind: 'delivered', state: 'inferred', journey: '', label: 'ack', why: 'ack not found', time: 'soon', ref: 'u2-p1' })] },
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

  it('orders title and conclusion, timeline, inference, evidence and notes', () => {
    const at = (s: string): number => page.indexOf(s);
    const order = ['<h1>Trace IAM</h1>', 'class="finding"', '<h2>Timeline</h2>', '<h2>Suy luận / chưa biết</h2>', '<h2>Bằng chứng</h2>', '<h3>Ghi chú</h3>'].map(at);
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(page).toContain('IAM đã gửi cho u1 &lt;b&gt;ok&lt;/b&gt;.');
    expect(page).toContain('<li>kết luận &lt;i&gt;một&lt;/i&gt;</li><li>kết luận hai</li>');
  });

  it('keeps the title small', () => {
    expect(page).toContain('h1{font-size:24px');
    expect(page).not.toContain('<h1>IAM đã gửi');
  });

  it('says what was not checked and never claims a point did not happen', () => {
    expect(page).toContain('Temporal không kiểm tra');
    expect(page).toContain('không ghi nhận');
    expect(page).not.toContain('không xảy ra');
    expect(page).not.toContain('18 phút');
    expect(page).not.toContain('Bộ lọc thời gian');
  });

  it('draws one lane per journey and a client lane per player, as SVG', () => {
    const timeline = between(page, '<h2>Timeline</h2>', '<h2>Kiểm tra kênh');
    expect(timeline.match(/<svg /g)).toHaveLength(3); // u1: journey + client, r2: client (its journey lane has no points)
    expect(timeline).toContain('Journey J1');
    expect(timeline).toContain('<strong>Client</strong>');
    expect(timeline).toContain('trigger fired');
    expect(timeline.indexOf('trigger fired')).toBeLessThan(timeline.indexOf('check call'));
    expect(timeline.indexOf('check call')).toBeLessThan(timeline.indexOf('push sent'));
    expect(timeline).toContain('class="nd n-sent"');
    expect(timeline).toContain('class="ring"');
    expect(timeline).toContain('check call *');
    expect(timeline).toContain('class="legend"');
    expect(page).toContain('.w3{max-width:');
  });

  it('shows times in ICT with one footnote for store time and a mark only where the time came from the message', () => {
    const timeline = between(page, '<h2>Timeline</h2>', '<h2>Kiểm tra kênh');
    expect(timeline).toContain('>08:00:00<');
    expect(timeline).not.toContain('≈');
    expect(page).toContain('Giờ là giờ kho log (_time)');
    expect(timeline).toContain('08:02:03 †');
    expect(page).toContain('† giờ in trong nội dung dòng log');
    expect(page).toContain('<td>25/10 08:02:03.123 †</td>');
    expect(page).toContain('<td>25/10 08:00:00</td>');
    expect(page).toContain('<td>?</td>');
    expect(page).toContain('<td>—</td>');
    expect(iamTracePage(REQ, { ...TRACE, users: [{ ...TRACE.users[0]!, points: [TRACE.users[0]!.points[0]!] }] })).not.toContain('†');
  });

  it('lists inferred points with their reason and the not recorded ones', () => {
    const section = between(page, '<h2>Suy luận / chưa biết</h2>', '<h2>Bằng chứng</h2>');
    expect(section).toContain('<li>u1: <strong>check call</strong>: worker lines lost after wait</li>');
    expect(section).toContain('<li>r2: <strong>ack</strong>: ack not found</li>');
    expect(section).toContain('<li>u1: inbox</li>');
    expect(section).toContain('không có nghĩa là chưa xảy ra');
    const clean = iamTracePage(REQ, { ...TRACE, users: [{ ...TRACE.users[0]!, points: [TRACE.users[0]!.points[0]!] }] });
    expect(clean).toContain('Không có mốc nào phải suy ra.');
    expect(clean).toContain('Mọi mốc đều tìm thấy dòng log.');
  });

  it('puts the evidence in one table with the journey and outcome beside each point', () => {
    const table = between(page, '<h2>Bằng chứng</h2>', '</table>');
    expect(table.match(/<tr>/g)).toHaveLength(7);
    expect(table).toContain('Gửi IAM: push sent<small>· u1 · Journey J1 · kết quả: đạt</small>');
    expect(table).toContain('SDK tracking: open<small>· u1 · kết quả: thông tin</small>');
    expect(table).toContain('Suy ra vì: worker lines lost after wait');
    expect(table).toContain('đã sửa khi kiểm chứng');
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

  it('shows the 24 hour banner only when the request had no time', () => {
    expect(page).toContain('<p class="banner">Đã tra 24 giờ gần nhất; thêm dd/mm hh:mm để tra ngày khác</p>');
    const dated = iamTracePage({ ...REQ, at: new Date(), windowStart: new Date(), windowEnd: new Date(), timeFilter: '_time:(a, b)', window: 'quanh 25/10 09:30 ICT' }, TRACE);
    expect(dated).not.toContain('class="banner"');
    expect(dated).not.toContain('Đã tra 24 giờ gần nhất');
  });

  it('counts verification over the points shown, once per player', () => {
    const dup = (id: string): MergedTrace['users'][number] => ({ id, user_id: 'U1', role_id: 'R1', points: [point({ kind: 'send', state: 'seen', evidence: 'J1 line', time: '1792890123123', check: 'confirmed' }), point({ kind: 'inbox', state: 'not_recorded', journey: '', label: 'inbox' })] });
    const both: MergedTrace = { ...TRACE, counts: { confirmed: 2, corrected: 0, unverified: 2 }, users: [dup('R1'), dup('U1')] };
    expect(iamTracePage(REQ, both)).toContain('1 mốc khớp, 0 mốc đã sửa, 1 mốc chưa kiểm chứng.');
    expect(iamTraceNotice(REQ, both)).toContain('1 user · 1 mốc ghi nhận · 0 mốc suy ra · 1 mốc không ghi nhận · 1 mốc chưa kiểm chứng');
  });

  it('never says verified when no shown point was checked', () => {
    const none: MergedTrace = { ...TRACE, verified: true, users: TRACE.users.map((u) => ({ ...u, points: u.points.map((p) => ({ ...p, check: 'unverified' as const })) })) };
    expect(iamTracePage(REQ, none)).toContain('Chưa kiểm chứng độc lập');
  });

  it('does not withhold a page because a label ends in a secret-looking key before a time, a gap or an id', () => {
    const many = (id: string, role: string): MergedTrace['users'][number] => ({ id, user_id: '', role_id: role, points: [point({ kind: 'send', state: 'seen', label: 'Nhận push token:', evidence: 'J1 line', time: '1792890123123' }), point({ kind: 'trigger', state: 'seen', label: 'Gửi lại', evidence: 'J1 line', time: '1792890124123' })] });
    const p = iamTracePage(REQ, { ...TRACE, users: [many('RID-TEST-01', ''), many('RID-TEST-02', '')] });
    expect(checkAnswerPage(p)).toBeUndefined();
    expect(leaksSecret(answerPageVisibleTexts(p), [])).toBe(false);
  });

  it('clips evidence and renders an empty client lane', () => {
    const long: MergedTrace = { ...TRACE, users: [{ id: 'u1', user_id: 'u1', role_id: '', points: [point({ kind: 'send', state: 'seen', evidence: 'x'.repeat(700), time: '1792890123123' })] }] };
    const p = iamTracePage(REQ, long);
    expect(checkAnswerPage(p)).toBeUndefined();
    expect(p).toContain('x'.repeat(600) + '…');
    expect(p).not.toContain('x'.repeat(601));
    expect(p).toContain('không ghi nhận mốc nào');
  });

  it('merges users that are one player into one section', () => {
    const merged = iamTracePage(REQ, { ...TRACE, users: [{ ...TRACE.users[0]!, role_id: 'R9' }, { id: 'R9', user_id: 'u1', role_id: 'R9', points: TRACE.users[0]!.points }] });
    expect(merged.match(/<h3>u1 \/ R9 /g)).toHaveLength(1);
    expect(between(merged, '<h2>Bằng chứng</h2>', '</table>').match(/<tr>/g)).toHaveLength(6);
  });

  it('fits a lane of many nodes: its viewBox grows and the lane scrolls', () => {
    const many: MergedTrace = { ...TRACE, users: [{ id: 'u1', user_id: 'u1', role_id: '', points: Array.from({ length: 30 }, (_, i) => point({ kind: 'condition', state: 'seen', label: `step ${i}`, evidence: 'J1', time: String(1792890000000 + i * 1000) })) }] };
    const p = iamTracePage(REQ, many);
    expect(checkAnswerPage(p)).toBeUndefined();
    expect(p).toContain(`viewBox="0 0 ${30 * 156 + 16} 150"`);
    expect(p).toContain('.scroll{overflow-x:auto');
    expect(p).toContain(`.w30{max-width:${30 * 156 + 16}px`);
  });

  it('leaves a secret visible to the secret check', () => {
    const leaky: MergedTrace = { ...TRACE, users: [{ id: 'u1', user_id: 'u1', role_id: '', points: [point({ kind: 'send', state: 'seen', evidence: 'key glsa_abcdefghijklmnopqrstuvwxyz' })] }] };
    expect(leaksSecret(answerPageVisibleTexts(iamTracePage(REQ, leaky)))).toBe(true);
  });

  it('iamTraceTexts reads every string of a trace or a merged trace', () => {
    const texts = iamTraceTexts(TRACE);
    for (const u of TRACE.users) for (const p of u.points) expect(texts).toContain(p.evidence);
    expect(texts).toContain('push sent: push accepted');
    expect(texts).toContain('kết luận hai');
    expect(texts).toContain(TRACE.finding);
    const raw: TraceResult = { status: 'done', finding: 'f', conclusion: [], missing: [], notes: [], users: [{ id: 'u1', user_id: 'u1', role_id: '', points: [{ kind: 'send', label: 'token', journey: '', outcome: 'info', channel: '', result: '', time: '', source_field: '', evidence: 'abcdefghijkl12', state: 'seen', why: '' }] }] };
    expect(iamTraceTexts(raw)).toContain('token: abcdefghijkl12');
    expect(leaksSecret(iamTraceTexts(raw))).toBe(true);
  });

  it('the notice counts points and says what was not checked', () => {
    const notice = iamTraceNotice(REQ, TRACE);
    expect(notice).toContain('2 user · 3 mốc ghi nhận · 2 mốc suy ra · 1 mốc không ghi nhận');
    expect(notice).toContain('Đã tra 24 giờ gần nhất; thêm dd/mm hh:mm để tra ngày khác');
    expect(iamTraceNotice({ ...REQ, at: new Date() }, TRACE)).not.toContain('thêm dd/mm hh:mm');
    expect(notice).toContain('1 mốc đã sửa khi kiểm chứng');
    expect(notice).toContain('3 mốc chưa kiểm chứng');
    expect(notice).toContain('Temporal không kiểm tra');
    expect(notice).toContain('24 giờ gần nhất');
    expect(notice).toContain('&lt;b&gt;ok&lt;/b&gt;');
    expect(notice).not.toContain('<script');
    expect(notice).not.toContain('chưa kiểm chứng độc lập');
    const allUnchecked: MergedTrace = { ...TRACE, verified: false, reason: 'verifier checked no point', users: TRACE.users.map((u) => ({ ...u, points: u.points.map((p) => ({ ...p, check: 'unverified' as const })) })) };
    const unverified = iamTraceNotice(REQ, allUnchecked);
    expect(unverified).toContain('6 mốc chưa kiểm chứng');
    expect(unverified).toContain('chưa kiểm chứng độc lập (phiên kiểm chứng không kiểm lại được mốc nào)');
    expect(unverified).not.toContain('đã sửa');
  });

  it('file name carries the message id and a UTC stamp', () => {
    expect(iamTraceFileName('1791513774214', new Date(Date.UTC(2026, 9, 25, 1, 2, 3)))).toBe('iam-trace-1791513774214-20261025-010203.html');
  });
});

describe('iam trace sample page', () => {
  const page = iamTracePage(SAMPLE_REQUEST, sampleTrace());

  it('renders a trace shaped like a real one through the unchanged page check', () => {
    expect(checkAnswerPage(page)).toBeUndefined();
    expect(leaksSecret(answerPageVisibleTexts(page), [])).toBe(false);
    expect(page.match(/<svg /g)).toHaveLength(4); // three lanes and the delivery paths figure
    expect(page).toContain('Journey …2368 / campaign …2800');
    expect(page).toContain('Journey …7184');
    expect(page).toContain('x3 đến 12:22:09');
    expect(page).toContain('26/10 13:26:00');
    expect(page).toContain('+1h53m');
    expect(page.match(/<h3>RID-TEST-01 \/ 1100000000000000001 /g)).toHaveLength(1);
  });

  it('adds the subscription check: the published channel against the subscribed ones, compared by audee', () => {
    const section = between(page, '<h2>Kiểm tra kênh subscribe</h2>', '<h2>Suy luận');
    expect(page.indexOf('<h2>Timeline</h2>')).toBeLessThan(page.indexOf('<h2>Kiểm tra kênh subscribe</h2>'));
    expect(section).toContain('Lệch game: message được publish lên game gamea nhưng các phiên SDK của user chỉ subscribe game gameb');
    expect(section).toContain(`<td>Publish kênh</td><td>${PUBLISHED}</td><td>gamea</td>`);
    expect(section).toContain(`<td>SDK subscribe</td><td>${SUBSCRIBED_ROLE}</td><td>gameb</td>`);
    expect(section.match(/<tr>/g)).toHaveLength(8); // header + 3 channel points, header + 3 paths
    expect(page).toContain(`kênh ${PUBLISHED}`);
  });

  it('draws the three ways a message reaches the SDK with what the logs say about each', () => {
    const section = between(page, '<h2>Kiểm tra kênh subscribe</h2>', '<h2>Suy luận');
    expect(section.match(/<svg class="wp"/g)).toHaveLength(1);
    expect(section).toContain('class="ob-block"');
    expect(section).toContain('class="ob-unknown"');
    expect(section).not.toContain('class="ob-ok"');
    expect(section).toContain('<td>1. Popup realtime<small>publish 1 lần lên role:gamea …</small></td><td>Không ai nhận</td><td>SDK chỉ subscribe game gameb</td>');
    expect(section).toContain('<td>2. Replay khi kết nối lại<small>chỉ message không phải App Inbox</small></td><td>Chưa kiểm tra được</td>');
    expect(section).toContain('<td>Không khớp gameId</td><td>Game SDK gameb ≠ game message gamea (suy từ kênh subscribe)</td>');
    expect(section).toContain('Câu cần hỏi team game/SDK: vì sao message được publish lên game gamea nhưng SDK của user lại init bằng game gameb?');
    expect(section).toContain('Inbox gọi thiếu hoặc sai roleId/serverId.');
    expect(section).toContain('Quá expiresAt của message.');
    expect(section).toContain('audee không kiểm lại code');
    expect(section).toContain('Message đã tạo');
  });

  it('puts the message facts in the figure', () => {
    const fig = between(page, '<svg class="wp"', '</svg>');
    expect(fig).toContain('25/10 10:28:16 ICT');
    expect(fig).toContain('gameId gamea');
    expect(fig).toContain('SDK user: gameb');
  });

  it('says the check cannot be made when the logs show neither channel', () => {
    const trace = sampleTrace();
    const bare: MergedTrace = { ...trace, users: trace.users.map((u) => ({ ...u, points: u.points.filter((p) => p.kind !== 'publish' && p.kind !== 'subscribe') })) };
    const section = between(iamTracePage(SAMPLE_REQUEST, bare), '<h2>Kiểm tra kênh subscribe</h2>', '<h2>Suy luận');
    expect(section).toContain('Không ghi nhận dòng message-delivery publish');
    expect(section).not.toContain('Câu cần hỏi');
    expect(section).not.toContain('ob-block');
    expect(section.match(/Chưa kiểm tra được/g)).toHaveLength(3 + 3); // figure and table, three paths each
  });

  // IAM_TRACE_SAMPLE_DIR=<dir> pnpm vitest run --project unit tests/render/iam-trace-page.test.ts writes the page for a visual check.
  it.runIf(process.env['IAM_TRACE_SAMPLE_DIR'] !== undefined)('writes the sample page for a visual check', () => {
    const dir = process.env['IAM_TRACE_SAMPLE_DIR'] as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), page);
    writeFileSync(join(dir, 'open.html'), iamTracePage({ ...SAMPLE_REQUEST, at: new Date(), timeFilter: '_time:(a, b)', window: 'quanh 25/10 10:30 ICT (từ 30 phút trước đến 3 giờ sau)' }, sampleTrace()));
  });
});
