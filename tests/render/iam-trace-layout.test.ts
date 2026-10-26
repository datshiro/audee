import { describe, expect, it } from 'vitest';
import type { CheckedPoint, IamTraceRequest, MergedTrace } from '../../src/capability/iam-trace-schema.js';
import { buildNodes, dateRange, formatGap, idTail, layoutTrace, mergePlayers, UNKNOWN_JOURNEY } from '../../src/render/iam-trace-layout.js';
import { CAMPAIGN, JOURNEY, OTHER_JOURNEY, ROLE_ID, SAMPLE_REQUEST, sampleTrace, USER_ID } from '../fixtures/iam-trace-sample.js';

const REQ: IamTraceRequest = { target: 'C1', users: ['u1'], since: '24h', window: '24 giờ gần nhất' };
const pt = (over: Partial<CheckedPoint> & Pick<CheckedPoint, 'kind'>): CheckedPoint => ({
  label: 'x', journey: 'J1', outcome: 'info', time: '', source_field: '_time', evidence: 'e', state: 'seen', why: '', ref: 'r', check: 'unverified', ...over,
});
const user = (id: string, points: CheckedPoint[], ids: Partial<{ user_id: string; role_id: string }> = {}): MergedTrace['users'][number] => ({ id, user_id: ids.user_id ?? '', role_id: ids.role_id ?? '', points });
const trace = (users: MergedTrace['users']): MergedTrace => ({ finding: 'f', conclusion: [], notes: [], verified: true, counts: { confirmed: 0, corrected: 0, unverified: 0 }, users });
// 2026-10-25 03:00:00Z is 10:00:00 ICT.
const T = (s: string): string => `2026-10-25T${s}Z`;

describe('formatGap', () => {
  it.each([
    [0, '+0s'],
    [40, '+0s'],
    [1100, '+1.1s'],
    [5000, '+5s'],
    [34_000, '+34s'],
    [59_999, '+59s'],
    [4 * 60_000, '+4m'],
    [4 * 60_000 + 10_000, '+4m10s'],
    [58 * 60_000 + 20_000, '+58m'],
    [(3 * 60 + 47) * 60_000, '+3h47m'],
    [2 * 3_600_000, '+2h'],
    [(19 * 60 + 43) * 60_000, '+19h43m'],
    [(1 * 60 + 54) * 60_000, '+1h54m'],
    [26 * 3_600_000, '+1d2h'],
    [48 * 3_600_000, '+2d'],
    [-5, '+0s'],
  ])('%i ms is %s', (ms, text) => {
    expect(formatGap(ms)).toBe(text);
  });
});

describe('dateRange and idTail', () => {
  it('collapses a range inside one month and keeps both months otherwise', () => {
    const ms = (iso: string): number => Date.parse(iso);
    expect(dateRange(ms('2026-10-22T03:00:00Z'), ms('2026-10-22T09:00:00Z'))).toBe('22/10');
    expect(dateRange(ms('2026-10-22T03:00:00Z'), ms('2026-10-23T03:00:00Z'))).toBe('22–23/10');
    expect(dateRange(ms('2026-10-30T03:00:00Z'), ms('2026-11-01T03:00:00Z'))).toBe('30/10–01/11');
    expect(dateRange(ms('2026-10-25T16:00:00Z'), ms('2026-10-25T17:30:00Z'))).toBe('25–26/10');
  });

  it('shortens long ids to their last four characters', () => {
    expect(idTail('9000000000000002368')).toBe('…2368');
    expect(idTail('J1')).toBe('J1');
    expect(idTail('123456')).toBe('123456');
  });
});

describe('buildNodes', () => {
  it('orders by time, converts to ICT and computes the gap to the next node', () => {
    const nodes = buildNodes([pt({ kind: 'send', label: 'b', time: T('03:00:01.100') }), pt({ kind: 'trigger', label: 'a', time: T('03:00:00.000') }), pt({ kind: 'inbox', label: 'c', time: T('04:54:01.100') })]);
    expect(nodes.map((n) => [n.label, n.time, n.gap])).toEqual([['a', '10:00:00', '+1.1s'], ['b', '10:00:01', '+1h54m'], ['c', '11:54:01', undefined]]);
  });

  it('shows the date only when the day changes', () => {
    const nodes = buildNodes([pt({ kind: 'trigger', label: 'a', time: T('16:00:00') }), pt({ kind: 'send', label: 'b', time: T('16:30:00') }), pt({ kind: 'inbox', label: 'c', time: '2026-10-25T18:00:00Z' }), pt({ kind: 'inbox', label: 'd', time: '2026-10-26T01:00:00Z' })]);
    expect(nodes.map((n) => n.time)).toEqual(['23:00:00', '23:30:00', '26/10 01:00:00', '08:00:00']);
  });

  it('collapses adjacent identical points into one node with the first time and the last time', () => {
    const rejected = (time: string): CheckedPoint => pt({ kind: 'frequency', label: 'Chặn', outcome: 'block', time });
    const nodes = buildNodes([pt({ kind: 'trigger', label: 'a', time: T('03:00:00') }), rejected(T('03:05:00')), rejected(T('03:05:30')), rejected(T('03:09:00')), pt({ kind: 'send', label: 'z', time: T('04:00:00') })]);
    expect(nodes.map((n) => [n.label, n.count, n.time, n.sub, n.gap])).toEqual([
      ['a', 1, '10:00:00', undefined, '+5m'],
      ['Chặn', 3, '10:05:00', 'x3 đến 10:09:00', '+51m'],
      ['z', 1, '11:00:00', undefined, undefined],
    ]);
  });

  it('puts the end date in the sub-label when a run crosses midnight, and writes only xN for one instant', () => {
    const b = (time: string): CheckedPoint => pt({ kind: 'frequency', label: 'B', outcome: 'block', time });
    const [cross] = buildNodes([b('2026-10-25T16:00:00Z'), b('2026-10-26T03:00:00Z')]);
    expect(cross?.sub).toBe('x2 đến 26/10 10:00');
    const [same] = buildNodes([b(T('03:00:00.100')), b(T('03:00:00.900'))]);
    expect(same?.sub).toBe('x2');
  });

  it('does not collapse points that differ in kind, label, outcome or state, nor merge non-adjacent repeats', () => {
    const base = { label: 'L', time: T('03:00:00') };
    const nodes = buildNodes([
      pt({ ...base, kind: 'condition', outcome: 'pass' }),
      pt({ ...base, kind: 'condition', outcome: 'block', time: T('03:00:01') }),
      pt({ ...base, kind: 'condition', outcome: 'block', time: T('03:00:02'), state: 'inferred', why: 'w' }),
      pt({ ...base, kind: 'frequency', outcome: 'block', time: T('03:00:03') }),
      pt({ ...base, kind: 'condition', outcome: 'pass', time: T('03:00:04') }),
    ]);
    expect(nodes).toHaveLength(5);
    expect(nodes.every((n) => n.count === 1)).toBe(true);
  });

  it('maps outcome and kind to a node class and marks inferred nodes', () => {
    const nodes = buildNodes([
      pt({ kind: 'trigger', label: 't', time: T('03:00:00') }),
      pt({ kind: 'condition', label: 'c', outcome: 'pass', time: T('03:00:01') }),
      pt({ kind: 'check_call', label: 'k', time: T('03:00:02') }),
      pt({ kind: 'send', label: 's', outcome: 'pass', time: T('03:00:03') }),
      pt({ kind: 'frequency', label: 'f', outcome: 'block', time: T('03:00:04') }),
      pt({ kind: 'send', label: 'blocked send', outcome: 'block', time: T('03:00:05') }),
      pt({ kind: 'wait_end', label: 'w', state: 'inferred', why: 'y', time: T('03:00:06') }),
      pt({ kind: 'delivered', label: 'd', state: 'not_recorded', evidence: '', source_field: '' }),
    ]);
    expect(nodes.map((n) => n.cls)).toEqual(['other', 'check', 'check', 'sent', 'block', 'block', 'other', 'missing']);
    expect(nodes.map((n) => n.inferred)).toEqual([false, false, false, false, false, false, true, false]);
  });

  it('keeps untimed points beside the timed point that preceded them, without a gap', () => {
    const nodes = buildNodes([
      pt({ kind: 'trigger', label: 'late', time: T('05:00:00') }),
      pt({ kind: 'delivered', label: 'ack', state: 'not_recorded', evidence: '', source_field: '' }),
      pt({ kind: 'send', label: 'early', time: T('03:00:00') }),
      pt({ kind: 'inbox', label: 'bad', time: 'soon' }),
    ]);
    expect(nodes.map((n) => [n.label, n.time, n.sub, n.gap])).toEqual([
      ['early', '10:00:00', undefined, undefined],
      ['bad', '?', undefined, undefined],
      ['late', '12:00:00', undefined, undefined],
      ['ack', '—', 'không ghi nhận', undefined],
    ]);
    expect(buildNodes([pt({ kind: 'send', label: 'a', time: T('03:00:00') }), pt({ kind: 'trigger', label: 'b', time: T('05:00:00') })])[0]?.gap).toBe('+2h');
  });

  it('puts an untimed point that leads the model order first and labels an inferred point with no time', () => {
    const nodes = buildNodes([pt({ kind: 'condition', label: 'guess', state: 'inferred', why: 'y' }), pt({ kind: 'send', label: 'real', time: T('03:00:00') })]);
    expect(nodes.map((n) => [n.label, n.time, n.sub])).toEqual([['guess', '—', 'suy ra'], ['real', '10:00:00', undefined]]);
  });

  it('marks a point only when its time was printed inside the message', () => {
    const nodes = buildNodes([pt({ kind: 'trigger', label: 'a', time: T('03:00:00'), source_field: '_time' }), pt({ kind: 'send', label: 'b', time: T('03:00:01'), source_field: 'ts' }), pt({ kind: 'inbox', label: 'c', time: T('03:00:02'), source_field: '' })]);
    expect(nodes.map((n) => n.marked)).toEqual([false, true, false]);
  });

  it('uses the kind name for an empty label', () => {
    expect(buildNodes([pt({ kind: 'send', label: '  ', time: T('03:00:00') })])[0]?.label).toBe('Gửi IAM');
  });
});

describe('mergePlayers', () => {
  it('merges users that share a userId or a roleId, whichever id they were asked by', () => {
    const merged = mergePlayers([
      user('RID1', [pt({ kind: 'send', time: T('03:00:00') })], { user_id: 'U1', role_id: 'RID1' }),
      user('U1', [pt({ kind: 'send', time: T('03:00:00') }), pt({ kind: 'inbox', label: 'only here', time: T('03:00:05') })], { user_id: 'U1', role_id: 'RID1' }),
      user('other', [pt({ kind: 'send', time: T('03:00:00') })], { user_id: 'U9' }),
    ]);
    expect(merged.map((p) => p.ids)).toEqual([['RID1', 'U1'], ['other']]);
    expect(merged[0]).toMatchObject({ userId: 'U1', roleId: 'RID1' });
    expect(merged[0]?.points.map((p) => p.label)).toEqual(['x', 'only here']);
  });

  it('merges when a requested id equals the other entry\'s role id even if its own ids are empty', () => {
    const merged = mergePlayers([user('RID1', []), user('U1', [], { user_id: 'U1', role_id: 'RID1' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.ids).toEqual(['RID1', 'U1']);
  });

  it('keeps two roles of one account apart but merges the same role asked by its userId', () => {
    expect(mergePlayers([user('r1', [], { user_id: 'U1', role_id: 'r1' }), user('r2', [], { user_id: 'U1', role_id: 'r2' })])).toHaveLength(2);
    expect(mergePlayers([user('r1', [], { user_id: 'U1', role_id: 'r1' }), user('U1', [], { user_id: 'U1', role_id: 'r1' })])).toHaveLength(1);
  });

  it('never merges the points of a single user with each other', () => {
    const ack = (why: string, state: CheckedPoint['state']): CheckedPoint => pt({ kind: 'delivered', label: 'ack', journey: '', state, why, evidence: '', source_field: '' });
    const merged = mergePlayers([user('a', [ack('', 'not_recorded'), ack('', 'not_recorded'), pt({ kind: 'condition', state: 'inferred', why: 'one', evidence: '' }), pt({ kind: 'condition', state: 'inferred', why: 'two', evidence: '' })], { user_id: 'U' })]);
    expect(merged[0]?.points).toHaveLength(4);
    const twice = mergePlayers([user('a', [ack('', 'not_recorded')], { user_id: 'U', role_id: 'R' }), user('b', [ack('', 'not_recorded')], { user_id: 'U', role_id: 'R' })]);
    expect(twice[0]?.points).toHaveLength(1);
  });

  it('keeps users with no shared id apart, and joins a chain of three', () => {
    expect(mergePlayers([user('a', [], { user_id: 'U1' }), user('b', [], { user_id: 'U2' })])).toHaveLength(2);
    expect(mergePlayers([user('a', [], { user_id: 'U1' }), user('b', [], { user_id: 'U1', role_id: 'R' }), user('c', [], { role_id: 'R' })])).toHaveLength(1);
  });

  it('keeps the better state when the same line was proven under one id and demoted under the other', () => {
    const line = (state: CheckedPoint['state'], why: string): CheckedPoint => pt({ kind: 'send', label: 'same', time: T('03:00:00'), evidence: 'one line', state, why });
    const merged = mergePlayers([user('a', [line('inferred', 'y')], { user_id: 'U' }), user('b', [line('seen', '')], { user_id: 'U' })]);
    expect(merged[0]?.points.map((p) => p.state)).toEqual(['seen']);
    const other = mergePlayers([user('a', [line('seen', '')], { user_id: 'U' }), user('b', [line('inferred', 'y')], { user_id: 'U' })]);
    expect(other[0]?.points.map((p) => p.state)).toEqual(['seen']);
  });

  it('keeps points that differ in evidence', () => {
    const merged = mergePlayers([user('a', [pt({ kind: 'send', evidence: 'one' })], { user_id: 'U' }), user('b', [pt({ kind: 'send', evidence: 'two' })], { user_id: 'U' })]);
    expect(merged[0]?.points).toHaveLength(2);
  });
});

describe('layoutTrace', () => {
  const players = layoutTrace(SAMPLE_REQUEST, sampleTrace());

  it('merges the two ids of the sample player into one section', () => {
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ ids: [ROLE_ID, USER_ID], userId: USER_ID, roleId: ROLE_ID });
    expect(players[0]?.points).toHaveLength(19);
  });

  it('draws the requested journey first, then the others, then the client lane', () => {
    const [player] = players;
    expect(player?.journeys.map((l) => l.title)).toEqual([`Journey …2368 / campaign ${idTail(CAMPAIGN)}`, 'Journey …7184']);
    expect(player?.client.title).toBe('Client');
    expect(JOURNEY.endsWith('2368') && OTHER_JOURNEY.endsWith('7184')).toBe(true);
  });

  it('collapses repeats, shows the day change and the lane dates', () => {
    const [first, second] = players[0]?.journeys ?? [];
    expect(first?.nodes.map((n) => [n.label, n.count, n.time])).toEqual([
      ['Run bắt đầu', 1, '10:28:15'],
      ['GameAPI role enrich', 1, '10:28:15'],
      ['Điều kiện', 1, '10:28:16'],
      ['Tần suất', 1, '10:28:16'],
      ['Gửi IAM', 1, '10:28:16'],
      ['Chặn tần suất', 3, '12:22:00'],
      ['Hết wait', 1, '26/10 13:26:00'],
    ]);
    expect(first?.nodes.map((n) => n.gap)).toEqual(['+0.4s', '+1.1s', '+0.1s', '+0.1s', '+1h53m', '+1d1h', undefined]);
    expect(first?.nodes[5]?.sub).toBe('x3 đến 12:22:09');
    expect(first?.sub).toBe('25–26/10');
    expect(second?.sub).toBe('25/10');
    expect(second?.nodes.map((n) => [n.label, n.count, n.cls, n.inferred])).toEqual([
      ['Run bắt đầu', 1, 'other', false],
      ['Gọi country gate', 1, 'check', true],
      ['Loại: event A', 1, 'block', false],
      ['Loại: event B', 2, 'block', false],
      ['Loại: event C', 1, 'block', false],
    ]);
  });

  it('puts delivered, SDK and inbox points on the client lane, with a not recorded node', () => {
    expect(players[0]?.client.nodes.map((n) => [n.label, n.cls, n.time])).toEqual([
      ['Ack delivered', 'missing', '—'],
      ['received', 'other', '10:28:19'],
      ['open', 'other', '10:28:44'],
      ['Inbox mark-read', 'other', '10:29:02'],
    ]);
    expect(players[0]?.client.nodes[0]?.sub).toBe('không ghi nhận');
  });

  it('lists the points lane by lane for the evidence table', () => {
    const labels = players[0]?.points.map((p) => p.label) ?? [];
    expect(labels.slice(0, 2)).toEqual(['Run bắt đầu', 'GameAPI role enrich']);
    expect(labels.at(-1)).toBe('Inbox mark-read');
  });

  it('gives a point with no journey the requested journey lane, and an empty lane when there are no server points', () => {
    const [p] = layoutTrace(REQ, trace([user('u1', [pt({ kind: 'trigger', journey: 'J7', time: T('03:00:00') }), pt({ kind: 'send', journey: '', time: T('03:00:01') })])]));
    expect(p?.journeys.map((l) => [l.title, l.nodes.length])).toEqual([['Journey J7', 2]]);
    const [empty] = layoutTrace(REQ, trace([user('u1', [pt({ kind: 'inbox', journey: '', time: T('03:00:00') })])]));
    expect(empty?.journeys).toHaveLength(1);
    expect(empty?.journeys[0]).toMatchObject({ title: UNKNOWN_JOURNEY, nodes: [] });
    expect(empty?.client.nodes).toHaveLength(1);
  });

  it('shows the campaign only on the requested lane, and treats a journey target as requested', () => {
    const onlyJourney = layoutTrace({ ...REQ, target: 'J2' }, trace([user('u1', [pt({ kind: 'trigger', journey: 'J1', time: T('03:00:00') }), pt({ kind: 'trigger', journey: 'J2', time: T('03:30:00') })])]));
    expect(onlyJourney[0]?.journeys.map((l) => l.title)).toEqual(['Journey J2', 'Journey J1']);
    const both = layoutTrace({ ...REQ, target: 'CAMP1', journey: 'J1' }, trace([user('u1', [pt({ kind: 'trigger', journey: 'J2', time: T('03:00:00') }), pt({ kind: 'trigger', journey: 'J1', time: T('03:30:00') })])]));
    expect(both[0]?.journeys.map((l) => l.title)).toEqual(['Journey J1 / campaign CAMP1', 'Journey J2']);
  });

  it('orders the other journeys by their first time', () => {
    const [p] = layoutTrace(REQ, trace([user('u1', [pt({ kind: 'trigger', journey: 'JB', time: T('05:00:00') }), pt({ kind: 'trigger', journey: 'JA', time: T('04:00:00') }), pt({ kind: 'trigger', journey: 'JC', time: T('06:00:00') })])]));
    expect(p?.journeys.map((l) => l.title)).toEqual(['Journey JA', 'Journey JB', 'Journey JC']);
  });

  it('lays out each requested user as its own player when they are different people', () => {
    const two = layoutTrace(REQ, trace([user('u1', [pt({ kind: 'send', time: T('03:00:00') })], { user_id: 'U1' }), user('u2', [pt({ kind: 'send', time: T('03:00:00') })], { user_id: 'U2' })]));
    expect(two.map((p) => p.ids)).toEqual([['u1'], ['u2']]);
  });
});
