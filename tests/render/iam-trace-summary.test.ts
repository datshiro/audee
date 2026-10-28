import { describe, expect, it } from 'vitest';
import type { CheckedPoint, IamTraceRequest, MergedTrace } from '../../src/capability/iam-trace-schema.js';
import { checkChannels, missingChannelTexts } from '../../src/render/iam-trace-channels.js';
import { layoutTrace } from '../../src/render/iam-trace-layout.js';
import { poSummary, type PoSummary, type VerdictKind } from '../../src/render/iam-trace-summary.js';

const REQ: IamTraceRequest = { target: 'C1', users: ['u1', 'r2'], since: '24h', window: '24 giờ gần nhất' };
const at = (hhmmss: string): string => `2026-10-25T${String(Number(hhmmss.slice(0, 2)) - 7).padStart(2, '0')}${hhmmss.slice(2)}.000Z`;
const point = (over: Partial<CheckedPoint> & Pick<CheckedPoint, 'kind'>): CheckedPoint => ({ label: '', journey: 'J1', outcome: 'info', channel: '', result: '', time: '', source_field: '_time', evidence: 'line', why: '', ref: 'u1-p1', check: 'confirmed', state: 'seen', ...over });
const trace = (...users: Array<{ id: string; points: CheckedPoint[] }>): MergedTrace => ({
  finding: 'f',
  conclusion: [],
  notes: [],
  verified: true,
  counts: { confirmed: 0, corrected: 0, unverified: 0 },
  users: users.map((u) => ({ id: u.id, user_id: u.id.startsWith('u') ? u.id : '', role_id: u.id.startsWith('r') ? u.id : '', points: u.points })),
});
const summaries = (t: MergedTrace): PoSummary[] => layoutTrace(REQ, t).map(poSummary);
const one = (...points: CheckedPoint[]): PoSummary => summaries(trace({ id: 'u1', points }))[0] as PoSummary;
const owners = (s: PoSummary): string[] => s.actions.map((a) => a.owner);
const allText = (s: PoSummary): string => [s.verdict.text, ...s.story, ...s.actions.flatMap((a) => [a.cause, a.owner, a.next])].join('\n');

const send = (over: Partial<CheckedPoint> = {}): CheckedPoint => point({ kind: 'send', label: 'Gửi IAM', outcome: 'pass', time: at('10:00:00'), ...over });
const client = (over: Partial<CheckedPoint> & Pick<CheckedPoint, 'kind'>): CheckedPoint => point({ journey: '', ...over });
const REALTIME_MISSING = missingChannelTexts(checkChannels([client({ kind: 'subscribe', channel: 'user:gameb:U' })]))[0] as string;

type Case = { name: string; points: CheckedPoint[]; kind: VerdictKind; text?: string; contains?: string; owners: string[]; cause?: string };
const CASES: Case[] = [
  { name: 'sent and acked', points: [send(), client({ kind: 'delivered', time: at('10:00:02') })], kind: 'received', text: 'Đã nhận: Apollo gửi lúc 10:00:00, game client nhận lúc 10:00:02.', owners: [] },
  { name: 'sent and opened', points: [send(), client({ kind: 'sdk_event', label: 'open', time: at('10:00:30') })], kind: 'received', contains: 'mở lúc 10:00:30', owners: [] },
  { name: 'inbox read only', points: [send(), client({ kind: 'inbox', evidence: 'PUT /api/v1/inbox/messages/read', time: at('10:05:00') })], kind: 'received', text: 'Đã nhận: Apollo gửi lúc 10:00:00, game client nhận lúc 10:05:00, mở lúc 10:05:00.', owners: [] },
  { name: 'receipt with no time', points: [send(), client({ kind: 'delivered', time: '' })], kind: 'received', text: 'Đã nhận: Apollo gửi lúc 10:00:00, game client nhận lúc ?.', owners: [] },
  { name: 'inbox counts only', points: [send(), client({ kind: 'inbox', evidence: 'GET /api/v1/inbox/counts', time: at('10:05:00') })], kind: 'sent_no_client', owners: ['Team game'] },
  { name: 'sent, nothing from the client', points: [send()], kind: 'sent_no_client', text: 'Apollo đã gửi lúc 10:00:00; chưa ghi nhận phía game client.', owners: ['Team game'] },
  {
    name: 'sent, wrong game',
    points: [send(), client({ kind: 'publish', channel: 'role:gamea:U:R:env', time: at('10:00:01') }), client({ kind: 'subscribe', channel: 'role:gameb:U:R:env', time: at('09:00:00') }), client({ kind: 'subscribe', channel: 'user:gameb:U', time: at('09:00:01') })],
    kind: 'sent_wrong_channel',
    text: 'Apollo đã gửi lúc 10:00:00, nhưng game client đăng ký sai kênh nên popup không tới được người chơi; chưa ghi nhận phía game client.',
    owners: ['Team game / SDK'],
  },
  {
    name: 'blocked at a condition',
    points: [point({ kind: 'trigger', label: 'Event trigger', time: at('10:00:00') }), point({ kind: 'condition', label: 'Validation: country', result: 'country OT', outcome: 'block', time: at('10:00:01') })],
    kind: 'blocked',
    text: 'Bị chặn tại bước Kiểm tra điều kiện (country): country OT, lúc 10:00:01.',
    owners: ['PO hoặc operator của campaign'],
  },
  { name: 'blocked at frequency', points: [point({ kind: 'frequency', label: 'Frequency check', result: 'đã gửi rồi', outcome: 'block', time: at('10:00:00') })], kind: 'blocked', text: 'Bị chặn tại bước Kiểm tra tần suất gửi: đã gửi rồi, lúc 10:00:00.', owners: ['PO hoặc operator của campaign'], cause: 'Vượt giới hạn tần suất gửi' },
  { name: 'sent in one journey, blocked in another', points: [send(), point({ kind: 'condition', label: 'Validation: country', outcome: 'block', journey: 'J2', time: at('10:01:00') })], kind: 'sent_no_client', owners: ['Team game'] },
  { name: 'only an inferred send', points: [send({ state: 'inferred', why: 'x' })], kind: 'unclear', text: 'Chưa rõ: Apollo có thể đã gửi (suy ra) nhưng không có dòng log gửi trực tiếp.', owners: ['Apollo dev'] },
  { name: 'nothing recorded', points: [send({ state: 'not_recorded', time: '', evidence: '' })], kind: 'unclear', text: 'Chưa rõ: không ghi nhận bước Apollo gửi IAM trong khoảng đã tra.', owners: ['Apollo dev'] },
  { name: 'send rejected', points: [send({ outcome: 'block', result: 'lỗi gửi' })], kind: 'blocked', text: 'Bị chặn tại bước Apollo gửi IAM: lỗi gửi, lúc 10:00:00.', owners: ['Apollo dev'] },
  { name: 'only an inferred block', points: [point({ kind: 'condition', label: 'Validation: country', outcome: 'block', state: 'inferred', why: 'x', time: at('10:00:00') })], kind: 'unclear', owners: ['Apollo dev'] },
  { name: 'receipt before the send', points: [client({ kind: 'sdk_event', label: 'open', time: at('09:59:00') }), send()], kind: 'sent_no_client', owners: ['Team game'] },
  { name: 'not checked by the verifier', points: [send({ check: 'unverified' }), client({ kind: 'delivered', time: at('10:00:02'), check: 'unverified' })], kind: 'received', owners: [] },
  {
    name: 'received, but the realtime channel is missing',
    points: [send(), client({ kind: 'delivered', time: at('10:00:02') }), client({ kind: 'subscribe', channel: 'user:gameb:U', time: at('09:00:00') })],
    kind: 'received',
    owners: ['Team game / SDK'],
    cause: REALTIME_MISSING,
  },
];

const RECEIPT = (p: CheckedPoint): boolean => p.kind === 'delivered' || p.kind === 'sdk_event' || (p.kind === 'inbox' && p.evidence.includes('/inbox/messages/read'));

describe('poSummary verdicts', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const s = one(...c.points);
      expect(s.verdict.kind).toBe(c.kind);
      if (c.text !== undefined) expect(s.verdict.text).toBe(c.text);
      if (c.contains !== undefined) expect(s.verdict.text).toContain(c.contains);
      expect(owners(s)).toEqual(c.owners);
      if (c.cause !== undefined) expect(s.actions.map((a) => a.cause)).toContain(c.cause);
    });
  }

  it('two players get their own verdicts', () => {
    const [a, b] = summaries(trace({ id: 'u1', points: [send(), client({ kind: 'delivered', time: at('10:00:02') })] }, { id: 'r2', points: [send({ ref: 'u2-p1' })] }));
    expect(a?.verdict.kind).toBe('received');
    expect(owners(a as PoSummary)).toEqual([]);
    expect(b?.verdict.kind).toBe('sent_no_client');
    expect(owners(b as PoSummary)).toEqual(['Team game']);
  });

  it('never asserts an absence and only claims what seen points support', () => {
    for (const c of CASES) {
      const s = one(...c.points);
      expect(allText(s)).not.toContain('không xảy ra');
      expect(allText(s)).not.toContain('Không nhận');
      const seen = c.points.filter((p) => p.state === 'seen');
      if (s.verdict.kind === 'blocked') expect(seen.some((p) => p.outcome === 'block')).toBe(true);
      if (s.verdict.kind === 'received') expect(seen.some((p) => p.kind === 'send') && seen.some(RECEIPT)).toBe(true);
    }
  });
});

describe('poSummary story', () => {
  const blocked = CASES.find((c) => c.name === 'blocked at a condition') as Case;

  it('tells the steps in business words and marks the block', () => {
    const story = one(...blocked.points).story.join('\n');
    expect(story).toContain('Người chơi phát sinh sự kiện kích hoạt');
    expect(story).toContain('Kiểm tra điều kiện (country): country OT');
    expect(story).toContain('Kiểm tra điều kiện (country): country OT — bị chặn');
  });

  it('marks repeats, inferred and missing steps, and says what the client showed', () => {
    const blocks = [1, 2, 3].map((s) => point({ kind: 'frequency', label: 'Frequency check', outcome: 'block', time: at(`10:00:0${s}`) }));
    const story = one(...blocks, point({ kind: 'wait_end', state: 'inferred', why: 'x', time: at('10:05:00') }), point({ kind: 'send', state: 'not_recorded' })).story;
    expect(story).toEqual(['Journey J1:', '- 10:00:01 Kiểm tra tần suất gửi — bị chặn (x3)', '- 10:05:00 Hết thời gian chờ (suy ra)', '- Không ghi nhận bước Apollo gửi IAM', 'Game client: chưa ghi nhận mốc nhận hay mở nào.']);
    expect(one(...blocks).verdict.text).toBe('Bị chặn tại bước Kiểm tra tần suất gửi, lúc 10:00:01. Còn 2 lần chặn khác.');
    expect(one(send(), client({ kind: 'sdk_event', label: 'received', time: at('10:00:05') }), client({ kind: 'sdk_event', label: 'Open', time: at('10:00:09') })).story.at(-1)).toBe('Game client: nhận lúc 10:00:05, mở lúc 10:00:09.');
  });

  it('cuts long lanes and extra journeys short', () => {
    const steps = Array.from({ length: 14 }, (_, i) => point({ kind: 'condition', label: `Validation: c${i}`, time: at(`10:00:${String(i + 10)}`) }));
    const lanes = ['J1', 'J2', 'J3', 'J4', 'J5'].map((j, i) => point({ kind: 'trigger', journey: j, time: at(`11:0${i}:00`) }));
    const story = one(...steps, ...lanes).story;
    expect(story).toContain('- … và 3 bước khác, xem Chi tiết kỹ thuật');
    expect(story).toContain('… và 2 journey khác, xem Chi tiết kỹ thuật');
  });

  it('never prints a send result', () => {
    const story = one(send({ result: 'HTTP 200' })).story.join('\n');
    expect(story).not.toContain('HTTP');
    expect(story).toContain('Apollo gửi IAM');
  });

  it('falls back to the label or the kind name for steps it does not know', () => {
    const story = (label: string): string => one(point({ kind: 'condition', label, time: at('10:00:00') })).story.join('\n');
    expect(story('Weird step')).toContain('- 10:00:00 Bước kiểm tra "Weird step"');
    expect(story('')).toContain('- 10:00:00 Kết quả điều kiện');
    expect(story('Evaluate điều kiện')).toContain('Kiểm tra điều kiện');
    expect(story('Evaluate điều kiện')).not.toContain('(');
  });
});
