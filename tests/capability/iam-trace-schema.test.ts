import { describe, expect, it } from 'vitest';
import {
  type ExtractedRequest,
  iamExtractPrompt,
  IAM_TRACE_SCHEMA,
  IAM_VERIFY_SCHEMA,
  type IamTraceRequest,
  ictTime,
  MISSING_TARGET,
  MAX_VERIFY_POINTS,
  mergeVerification,
  MISSING_USERS,
  numberPoints,
  parseTraceOutput,
  parseVerifyOutput,
  JOURNEY_MISSING_WHY,
  JOURNEY_UNPROVEN_WHY,
  pointProblem,
  proveChannels,
  CHANNEL_UNPROVEN_WHY,
  proveJourneys,
  rowOf,
  type TracePoint,
  type TraceResult,
  type Verdict,
  verifierPoints,
  validateRequest,
  verifierSince,
} from '../../src/capability/iam-trace-schema.js';
import type { RunResult } from '../../src/runner/run.js';

const res = (structured: unknown, extra: Partial<RunResult> = {}): RunResult => ({ isError: false, text: '', structured, denials: [], toolUses: [], durationMs: 1, ...extra });
const REQ: IamTraceRequest = { target: 'C1', users: ['u1', 'r2'], since: '24h', window: '24 giờ gần nhất' };
const point = (over: Partial<TracePoint> = {}): TracePoint => ({ kind: 'trigger', label: 'trigger', journey: 'J1', outcome: 'info', channel: '', result: '', time: '1761354123456', source_field: '_time', evidence: 'journey workflow executed J1', state: 'seen', why: '', ...over });
const GOOD: TraceResult = {
  status: 'done',
  finding: 'IAM đã gửi.',
  conclusion: ['IAM đã gửi.'],
  users: [
    {
      id: 'u1',
      user_id: 'u1',
      role_id: 'role-1',
      points: [
        point(),
        point({ kind: 'check_call', label: 'CheckQuota', time: '', source_field: '', evidence: '', state: 'inferred', why: 'node sau đã chạy' }),
        point({ kind: 'inbox', label: 'inbox', time: '', source_field: '', evidence: '', state: 'not_recorded' }),
      ],
    },
  ],
  missing: [],
  notes: [],
};
const clone = <T>(v: T): T => structuredClone(v);

describe('validateRequest', () => {
  const now = new Date('2026-10-25T05:00:00Z'); // 12:00 ICT
  const NO_TIME = { raw: '', local: '' };
  const ex = (over: Partial<ExtractedRequest> = {}): ExtractedRequest => ({ target: { id: 'C123', kind: 'unknown' }, journey_id: '', users: [{ id: 'u1', kind: 'user' }, { id: 'r2', kind: 'role' }], time: NO_TIME, ...over });
  const MSG = 'iam_trace C123 u1, r2';

  it('reads the 30/10 message with its campaign, journey and role', () => {
    const text = 'check thử user role 4QX2-TMBV-8NRC dùng campaign 2100000000000000101 journeyId: 2100000000000000202 đã send IAM chưa iam_trace';
    const { request, missing } = validateRequest({ target: { id: '2100000000000000101', kind: 'campaign' }, journey_id: '2100000000000000202', users: [{ id: '4QX2-TMBV-8NRC', kind: 'role' }], time: NO_TIME }, text, now);
    expect(missing).toEqual([]);
    expect(request).toEqual({ target: '2100000000000000101', kind: 'campaign', journey: '2100000000000000202', users: ['4QX2-TMBV-8NRC'], since: '24h', window: '24 giờ gần nhất' });
  });

  it('keeps a bare target without a kind and the default window', () => {
    const { request, missing } = validateRequest(ex(), MSG, now);
    expect(missing).toEqual([]);
    expect(request).toEqual({ target: 'C123', users: ['u1', 'r2'], since: '24h', window: '24 giờ gần nhất' });
  });

  it('takes a journey id as the target when there is no campaign', () => {
    const { request } = validateRequest(ex({ target: { id: '', kind: 'unknown' }, journey_id: '2112496888072355840' }), 'journeyInfo id 2112496888072355840 UID: u1 RID: r2', now);
    expect(request).toMatchObject({ target: '2112496888072355840', kind: 'journey', users: ['u1', 'r2'] });
    expect(request?.journey).toBeUndefined();
  });

  it('drops a journey id beside a journey target', () => {
    const { request } = validateRequest(ex({ target: { id: 'J1', kind: 'journey' }, journey_id: 'J2' }), 'J1 J2 u1 r2', now);
    expect(request).toMatchObject({ target: 'J1', kind: 'journey' });
    expect(request?.journey).toBeUndefined();
  });

  it('drops ids the message does not carry as whole tokens', () => {
    expect(validateRequest(ex({ users: [{ id: 'u1', kind: 'user' }, { id: 'u9', kind: 'user' }] }), MSG, now).request?.users).toEqual(['u1']);
    expect(validateRequest(ex({ users: [{ id: 'u', kind: 'user' }] }), MSG, now)).toEqual({ missing: [MISSING_USERS] });
    expect(validateRequest(ex({ target: { id: 'C12', kind: 'campaign' } }), MSG, now)).toEqual({ missing: [MISSING_TARGET] });
    expect(validateRequest(ex({ users: [{ id: '4QX2TMBV8NRC', kind: 'role' }] }), 'role 4QX2-TMBV-8NRC campaign C123', now)).toEqual({ missing: [MISSING_USERS] });
    for (const id of ['4QX2-TMBV', 'TMBV-8NRC', 'TMBV']) expect(validateRequest(ex({ users: [{ id, kind: 'role' }] }), 'role 4QX2-TMBV-8NRC campaign C123', now).missing, id).toEqual([MISSING_USERS]);
    expect(validateRequest(ex({ target: { id: '2026', kind: 'unknown' }, users: [{ id: '10', kind: 'user' }] }), 'iam_trace 2026-10-25 user abc', now).missing).toEqual([MISSING_TARGET, MISSING_USERS]);
  });

  it('never takes a part of a date or a clock time for an id', () => {
    const one = (target: string, user: string, message: string) => validateRequest(ex({ target: { id: target, kind: 'unknown' }, users: [{ id: user, kind: 'user' }] }), message, now).missing;
    expect(one('25', 'u1', 'iam_trace 25/10 09:30 user u1')).toEqual([MISSING_TARGET]);
    expect(one('C123', '30', 'C123 lúc 09:30')).toEqual([MISSING_USERS]);
    expect(one('C123', '30', 'C123 lúc 9h30')).toEqual([MISSING_USERS]);
    expect(one('2027', 'u1', 'C123 u1 28/12/2027')).toEqual([MISSING_TARGET]);
    expect(one('C123', 'u1', 'C123 u1 25/10 09:30')).toEqual([]);
  });

  it('keeps ids behind labels, inside links and before trailing punctuation', () => {
    const message = 'UID:abc1 RID: r2. xem https://hub.example/apollo/campaign/2114622278003490816?tab=flow nhé';
    const { request } = validateRequest(ex({ target: { id: '2114622278003490816', kind: 'campaign' }, users: [{ id: 'abc1', kind: 'user' }, { id: 'r2', kind: 'role' }] }), message, now);
    expect(request).toMatchObject({ target: '2114622278003490816', kind: 'campaign', users: ['abc1', 'r2'] });
  });

  it('reads a bare id beside a journey id as the campaign', () => {
    const { request } = validateRequest(ex({ target: { id: '1234', kind: 'unknown' }, journey_id: '5678' }), '1234 journeyId 5678 u1 r2', now);
    expect(request).toMatchObject({ target: '1234', kind: 'campaign', journey: '5678' });
  });

  it('names what is missing', () => {
    expect(validateRequest(ex({ target: { id: '', kind: 'unknown' }, users: [] }), 'iam_trace giúp', now)).toEqual({ missing: [MISSING_TARGET, MISSING_USERS] });
    expect(validateRequest(ex({ users: [] }), MSG, now)).toEqual({ missing: [MISSING_USERS] });
  });

  it('keeps the target out of the users, de-duplicates them in order and caps them', () => {
    expect(validateRequest(ex({ users: [{ id: 'r2', kind: 'role' }, { id: 'u1', kind: 'user' }, { id: 'r2', kind: 'unknown' }, { id: 'C123', kind: 'unknown' }] }), MSG, now).request?.users).toEqual(['r2', 'u1']);
    const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    expect(validateRequest(ex({ users: users.map((id) => ({ id, kind: 'user' })) }), `C123 ${users.join(' ')}`, now).missing).toContain('tối đa 5 userId/roleId mỗi lần');
  });

  it('rejects an id with other characters', () => {
    expect(validateRequest(ex({ users: [{ id: 'u1 x', kind: 'user' }] }), 'C123 u1 x', now)).toEqual({ missing: [MISSING_USERS] });
  });

  it('windows a time from 30 minutes before to 3 hours after, clipped to now', () => {
    const { request, missing } = validateRequest(ex({ time: { raw: '9h30 sáng nay', local: '2026-10-25 09:30' } }), MSG, now);
    expect(missing).toEqual([]);
    expect(request?.at?.toISOString()).toBe('2026-10-25T02:30:00.000Z');
    expect(request?.since).toBe('4h');
    expect(request?.timeFilter).toBe('_time:(2026-10-25T02:00:00Z, 2026-10-25T05:00:00Z)');
    expect(request?.windowStart?.toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(request?.windowEnd?.toISOString()).toBe('2026-10-25T05:00:00.000Z');
    expect(request?.window).toContain('25/10 09:30');
  });

  it('rejects a time that does not parse, does not exist, is in the future or outside the retention', () => {
    const problem = (local: string): string => validateRequest(ex({ time: { raw: 'lúc đó', local } }), `${MSG} lúc đó`, now).missing.join('\n');
    expect(problem('25/10 09:30')).toContain('không đọc được thời điểm "lúc đó"');
    expect(problem('2026-02-31 09:00')).toContain('không đọc được');
    expect(problem('2026-10-25 15:00')).toContain('tương lai');
    expect(problem('2026-10-10 09:00')).toContain('trong 7 ngày gần nhất');
  });

  it('keeps since within the retention for the oldest accepted time', () => {
    expect(validateRequest(ex({ time: { raw: '18/10 15:00', local: '2026-10-18 15:00' } }), MSG, now).request?.since).toBe('167h');
    expect(validateRequest(ex({ time: { raw: '18/10 14:59', local: '2026-10-18 14:59' } }), MSG, now).missing.join('\n')).toContain('trong 7 ngày gần nhất');
  });

  it('quotes the time only when the message holds those words', () => {
    const out = validateRequest(ex({ time: { raw: 'SECRET-abcdefg', local: 'nope' } }), MSG, now).missing.join('\n');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('không đọc được thời điểm trong tin nhắn');
  });

  it('reads the normalised time with a T, seconds or the Vietnam offset', () => {
    for (const local of ['2026-10-25T09:30', '2026-10-25 09:30:00', '2026-10-25T09:30:00+07:00']) {
      expect(validateRequest(ex({ time: { raw: '9h30', local } }), `${MSG} 9h30`, now).request?.at?.toISOString(), local).toBe('2026-10-25T02:30:00.000Z');
    }
  });

  it('refuses a time in any other zone or with impossible seconds, and drops valid seconds', () => {
    const one = (local: string) => validateRequest(ex({ time: { raw: '9h30', local } }), `${MSG} 9h30`, now);
    for (const local of ['2026-10-25T09:30:00Z', '2026-10-25T09:30:00+00:00', '2026-10-25T09:30-05:00', '2026-10-25T09:30:60']) {
      expect(one(local).missing.join('\n'), local).toContain('không đọc được thời điểm');
    }
    expect(one('2026-10-25T09:30:45+0700').request?.at?.toISOString()).toBe('2026-10-25T02:30:00.000Z');
  });

  it('reads a one-digit hour', () => {
    expect(validateRequest(ex({ time: { raw: '9h', local: '2026-10-25 9:00' } }), `${MSG} 9h`, now).request?.at?.toISOString()).toBe('2026-10-25T02:00:00.000Z');
  });

  it('takes last year for a dd/mm the model put in the future, but not for words or a year', () => {
    const jan = new Date('2027-01-02T03:00:00Z');
    const dated = (raw: string, local: string) => validateRequest(ex({ time: { raw, local } }), `${MSG} ${raw}`, jan);
    expect(dated('28/12 23:00', '2027-12-28 23:00').request?.at?.toISOString()).toBe('2026-12-28T16:00:00.000Z');
    expect(dated('28/12/2027 23:00', '2027-12-28 23:00').missing.join('\n')).toContain('tương lai');
    expect(dated('ngày mai 9h', '2027-01-03 09:00').missing.join('\n')).toContain('tương lai');
    expect(dated('2/1 23:00', '2027-01-02 23:00').missing.join('\n')).toContain('tương lai');
    expect(dated('28/12/26 23:00', '2027-12-28 23:00').missing.join('\n')).toContain('tương lai');
    expect(dated('5/1 09:00', '2027-01-05 09:00').missing.join('\n')).toContain('tương lai');
  });

  it('asks for the time in words it can read when only raw is given', () => {
    expect(validateRequest(ex({ time: { raw: 'hôm kia', local: '' } }), MSG, now).missing.join('\n')).toContain('dd/mm hh:mm');
  });
});

describe('iamExtractPrompt', () => {
  it('gives the send time in Vietnam time and fences the message as data', () => {
    const prompt = iamExtractPrompt('iam_trace C1 u1', new Date('2026-10-30T10:47:00Z'));
    expect(prompt).toContain('2026-10-30 17:47 Vietnam time (Thứ sáu)');
    expect(prompt).toContain('<<<MESSAGE\niam_trace C1 u1\nMESSAGE>>>');
    expect(iamExtractPrompt('a MESSAGE>>> b <<<MESSAGE', new Date())).toContain('a MESSAGE››› b ‹‹‹MESSAGE\nMESSAGE>>>');
  });
});

describe('verifierSince', () => {
  it('adds the elapsed whole hours plus one', () => {
    expect(verifierSince('4h', 0)).toBe('5h');
    expect(verifierSince('24h', 59 * 60_000)).toBe('25h');
    expect(verifierSince('24h', 2 * 3_600_000 + 1)).toBe('27h');
  });

  it('caps at the retention', () => {
    expect(verifierSince('167h', 3_600_000)).toBe('168h');
  });
});

describe('ictTime', () => {
  it('converts epochs and ISO times to ICT', () => {
    expect(ictTime('1761354123456')?.text).toBe('25/10 08:02:03.456');
    expect(ictTime('1761354123')?.text).toBe('25/10 08:02:03');
    expect(ictTime('1761354123.5')?.text).toBe('25/10 08:02:03.500');
    expect(ictTime('2026-10-25T01:02:03.123Z')?.text).toBe('25/10 08:02:03.123');
    expect(ictTime('2026-10-25T08:02:03+07:00')?.text).toBe('25/10 08:02:03');
    expect(ictTime('2026-10-25T01:02:03.123456789Z')?.ms).toBe(1792890123123);
  });

  it('accepts a space separator, a compact offset and micro or nano epochs', () => {
    expect(ictTime('2026-10-25 08:02:03+0700')?.ms).toBe(1792890123000);
    expect(ictTime(' 2026-10-25 01:02:03.5Z ')?.text).toBe('25/10 08:02:03.500');
    expect(ictTime('2026-10-24T20:02:03-05:00')?.text).toBe('25/10 08:02:03');
    expect(ictTime('1761354123456789')?.text).toBe('25/10 08:02:03.456');
    expect(ictTime('1761354123456789012')?.text).toBe('25/10 08:02:03.456');
  });

  it('rejects anything else', () => {
    expect(ictTime('yesterday')).toBeUndefined();
    expect(ictTime('')).toBeUndefined();
    expect(ictTime('2026-10-25T01:02:03')).toBeUndefined();
    expect(ictTime('2026-02-30T01:02:03Z')).toBeUndefined();
    expect(ictTime('2026-10-25T01:02:03+07:99')).toBeUndefined();
    expect(ictTime('17613541234')).toBeUndefined();
  });
});

describe('pointProblem', () => {
  it('accepts the three valid shapes, whatever the time looks like', () => {
    for (const p of GOOD.users[0]!.points) expect(pointProblem(p)).toBeUndefined();
    expect(pointProblem(point({ time: 'soon' }))).toBeUndefined();
  });

  it('names a broken point', () => {
    expect(pointProblem(point({ evidence: '' }))).toBeDefined();
    expect(pointProblem(point({ state: 'inferred', why: '' }))).toBeDefined();
    expect(pointProblem(point({ state: 'not_recorded', evidence: '' }))).toBeDefined();
    expect(pointProblem(point({ state: 'not_recorded', time: '' }))).toBeDefined();
  });
});

describe('parseTraceOutput', () => {
  it('parses a valid trace', () => {
    expect(parseTraceOutput(res(GOOD), REQ).users[0]?.points).toHaveLength(3);
  });

  it('throws a fixed message for each contract break', () => {
    expect(() => parseTraceOutput(res(GOOD, { isError: true }), REQ)).toThrow('trace reported an error');
    expect(() => parseTraceOutput(res(undefined), REQ)).toThrow('trace returned no structured result');
    expect(() => parseTraceOutput(res({ ...GOOD, extra: 1 }), REQ)).toThrow('trace result does not match the contract');
    const maybe = clone(GOOD) as unknown as { users: Array<{ points: Array<Record<string, unknown>> }> };
    maybe.users[0]!.points[0]!['state'] = 'maybe';
    expect(() => parseTraceOutput(res(maybe), REQ)).toThrow('trace result does not match the contract');
    expect(() => parseTraceOutput(res({ ...GOOD, status: 'failed' }), REQ)).toThrow('trace session could not finish');
    expect(() => parseTraceOutput(res({ ...GOOD, status: 'need_input', missing: [] }), REQ)).toThrow('trace needs input but does not say what is missing');
    expect(() => parseTraceOutput(res({ ...GOOD, users: [] }), REQ)).toThrow('trace is done but has no users');
  });

  it('keeps a need_input result with its missing items', () => {
    const t = parseTraceOutput(res({ ...GOOD, status: 'need_input', users: [], missing: ['không rõ IAM'] }), REQ);
    expect(t.missing).toEqual(['không rõ IAM']);
  });

  it('cuts a user to 60 points with one note', () => {
    const many = clone(GOOD);
    many.users[0]!.points = Array.from({ length: 65 }, () => point());
    const t = parseTraceOutput(res(many), { ...REQ, users: ['u1'] });
    expect(t.users[0]?.points).toHaveLength(60);
    expect(t.notes).toEqual(['Chỉ hiển thị 60 mốc đầu cho mỗi user.']);
  });

  it('drops users that were not requested or repeat, with one note', () => {
    const t0 = clone(GOOD);
    t0.users = [t0.users[0]!, { ...t0.users[0]!, id: 'x9' }, { ...t0.users[0]!, id: 'x8' }, { ...t0.users[0]!, role_id: 'other' }, { ...t0.users[0]!, id: 'r2' }];
    const t = parseTraceOutput(res(t0), REQ);
    expect(t.users.map((u) => [u.id, u.role_id])).toEqual([['u1', 'role-1'], ['r2', 'role-1']]);
    expect(t.notes).toEqual(['Bỏ qua user không có trong yêu cầu hoặc bị lặp.']);
  });

  it('notes how many requested users the trace left out, never which', () => {
    const t = parseTraceOutput(res(GOOD), { ...REQ, users: ['u1', 'r2', 'SENTINEL-9'] });
    expect(t.notes).toEqual(['Kết quả thiếu 2 trong 3 user được yêu cầu.']);
    expect(t.notes.join('')).not.toContain('SENTINEL');
    expect(parseTraceOutput(res(GOOD), { ...REQ, users: ['u1'] }).notes).toEqual([]);
    expect(parseTraceOutput(res({ ...GOOD, status: 'need_input', users: [], missing: ['không rõ IAM'] }), REQ).notes).toEqual([]);
  });

  it('fails when no requested user is left', () => {
    expect(() => parseTraceOutput(res({ ...GOOD, users: [{ ...GOOD.users[0]!, id: 'x9' }] }), REQ)).toThrow('trace is done but has no users');
  });

  it('caps the users at MAX_USERS', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const t = parseTraceOutput(res({ ...GOOD, users: ids.map((id) => ({ ...GOOD.users[0]!, id })) }), { ...REQ, users: ids });
    expect(t.users.map((u) => u.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('demotes a broken point to inferred with a fixed why', () => {
    const bad = clone(GOOD);
    bad.users[0]!.points = [point({ evidence: '' }), point({ state: 'inferred', why: '' }), point({ state: 'not_recorded' })];
    const t = parseTraceOutput(res(bad), REQ);
    for (const p of t.users[0]!.points) {
      expect(p.state).toBe('inferred');
      expect(p.why).toBe('bằng chứng không hợp lệ');
    }
    expect(t.users[0]!.points[2]?.evidence).toBe('journey workflow executed J1');
  });
});

describe('parseVerifyOutput', () => {
  const verdicts = [
    { ref: 'u1-p1', verdict: 'CONFIRMED' },
    { ref: 'u1-p2', verdict: 'CORRECTED', time: '1761354999000', source_field: 'ts', evidence: 'new line', state: 'seen', why: '' },
  ];

  it('parses a verdict list where CONFIRMED carries only ref and verdict', () => {
    expect(parseVerifyOutput(res({ status: 'done', verdicts, notes: [] }))).toEqual(verdicts);
  });

  it('throws a fixed message for each contract break', () => {
    expect(() => parseVerifyOutput(res({ status: 'done', verdicts, notes: [] }, { isError: true }))).toThrow('verifier reported an error');
    expect(() => parseVerifyOutput(res(undefined))).toThrow('verifier returned no structured result');
    expect(() => parseVerifyOutput(res({ status: 'done', verdicts: [{ ref: 'u1-p1', verdict: 'MAYBE' }], notes: [] }))).toThrow('verifier result does not match the contract');
    expect(() => parseVerifyOutput(res({ status: 'done', verdicts: [{ verdict: 'CONFIRMED' }], notes: [] }))).toThrow('verifier result does not match the contract');
    expect(() => parseVerifyOutput(res({ status: 'failed', verdicts: [], notes: ['không có công cụ'] }))).toThrow('verifier could not finish');
  });

  it('exposes both schemas as objects with required fields', () => {
    expect(IAM_TRACE_SCHEMA['required']).toEqual(['status', 'finding', 'conclusion', 'users', 'missing', 'notes']);
    expect(IAM_VERIFY_SCHEMA['required']).toEqual(['status', 'verdicts', 'notes']);
  });
});

describe('mergeVerification', () => {
  const corrected: Verdict = { ref: 'u1-p2', verdict: 'CORRECTED', time: '1761354999000', source_field: 'ts', evidence: 'new line J1', state: 'seen', why: '' };
  const traced = (ref: string): TracePoint => {
    const [u, p] = ref.slice(1).split('-p').map(Number) as [number, number];
    return GOOD.users[u - 1]!.points[p - 1]!;
  };

  it('numbers points per user', () => {
    const n = numberPoints(GOOD);
    expect(n.map((p) => p.ref)).toEqual(['u1-p1', 'u1-p2', 'u1-p3']);
    expect(n.every((p) => p.user === 'u1')).toBe(true);
  });

  it('gives the verifier seen points first, then the rest, at most 15', () => {
    const t = clone(GOOD);
    t.users.push({ id: 'r2', user_id: '', role_id: 'r2', points: [point()] });
    t.users[0]!.points = [GOOD.users[0]!.points[1]!, point(), GOOD.users[0]!.points[2]!];
    expect(verifierPoints(numberPoints(t)).map((p) => p.ref)).toEqual(['u1-p2', 'u2-p1', 'u1-p1', 'u1-p3']);
    const many = clone(GOOD);
    many.users[0]!.points = [GOOD.users[0]!.points[1]!, ...Array.from({ length: 20 }, () => point())];
    const given = verifierPoints(numberPoints(many));
    expect(MAX_VERIFY_POINTS).toBe(15);
    expect(given).toHaveLength(15);
    expect(given.map((p) => p.ref)).toEqual(Array.from({ length: 15 }, (_, i) => `u1-p${i + 2}`));
  });

  it('applies the first verdict per ref and ignores unknown refs', () => {
    const verdicts: Verdict[] = [{ ref: 'u1-p1', verdict: 'CONFIRMED' }, corrected, { ...corrected, ref: 'u9-p9' }, { ref: 'u1-p2', verdict: 'CONFIRMED' }];
    const m = mergeVerification(GOOD, verdicts);
    const [p1, p2, p3] = m.users[0]!.points;
    expect(p1).toEqual({ ...traced('u1-p1'), ref: 'u1-p1', check: 'confirmed' });
    expect(p2).toEqual({ ...traced('u1-p2'), time: '1761354999000', source_field: 'ts', evidence: 'new line J1', state: 'seen', why: '', ref: 'u1-p2', check: 'corrected' });
    expect(p3).toEqual({ ...traced('u1-p3'), ref: 'u1-p3', check: 'unverified' });
    expect(m.counts).toEqual({ confirmed: 1, corrected: 1, unverified: 1 });
    expect(m.verified).toBe(true);
    expect(m.reason).toBeUndefined();
    expect(m.users[0]).toMatchObject({ id: 'u1', user_id: 'u1', role_id: 'role-1' });
    expect(m.finding).toBe(GOOD.finding);
  });

  it('marks everything unverified without verdicts', () => {
    const m = mergeVerification(GOOD, undefined);
    expect(m.verified).toBe(false);
    expect(m.reason).toBeUndefined();
    expect(m.users[0]!.points.every((p) => p.check === 'unverified')).toBe(true);
    expect(m.counts).toEqual({ confirmed: 0, corrected: 0, unverified: 3 });
  });

  it('ignores an invalid correction and keeps the point as traced', () => {
    const invalid: Verdict[] = [
      { ref: 'u1-p3', verdict: 'CORRECTED', time: '1761354999000', source_field: 'ts', evidence: '', state: 'seen', why: '' },
      { ref: 'u1-p3', verdict: 'CORRECTED', time: '1761354999000', source_field: 'ts', evidence: '', state: 'not_recorded', why: '' },
      { ref: 'u1-p3', verdict: 'CORRECTED', source_field: 'ts', evidence: 'line', state: 'seen', why: '' },
    ];
    for (const v of invalid) {
      const m = mergeVerification(GOOD, [{ ref: 'u1-p1', verdict: 'CONFIRMED' }, { ref: 'u1-p2', verdict: 'CONFIRMED' }, v]);
      expect(m.users[0]!.points[2]).toEqual({ ...traced('u1-p3'), ref: 'u1-p3', check: 'unverified' });
      expect(m.counts).toEqual({ confirmed: 2, corrected: 0, unverified: 1 });
    }
  });

  it('applies a correction whose time does not parse', () => {
    const m = mergeVerification(GOOD, [{ ref: 'u1-p1', verdict: 'CONFIRMED' }, { ref: 'u1-p2', verdict: 'CONFIRMED' }, { ...corrected, ref: 'u1-p3', time: 'soon' }]);
    expect(m.users[0]!.points[2]).toMatchObject({ time: 'soon', state: 'seen', check: 'corrected' });
  });

  it('applies no correction when the verifier changed most points', () => {
    const verdicts: Verdict[] = [{ ref: 'u1-p1', verdict: 'CONFIRMED' }, corrected, { ...corrected, ref: 'u1-p3' }];
    const m = mergeVerification(GOOD, verdicts);
    expect(m.verified).toBe(false);
    expect(m.reason).toBe('verifier changed most points');
    expect(m.users[0]!.points).toEqual(GOOD.users[0]!.points.map((p, i) => ({ ...p, ref: `u1-p${i + 1}`, check: 'unverified' })));
    expect(m.counts).toEqual({ confirmed: 0, corrected: 0, unverified: 3 });
  });

  it('is unverified when no verdict matches a given point', () => {
    for (const verdicts of [[], [{ ref: 'u9-p9', verdict: 'CONFIRMED' }]] as Verdict[][]) {
      const m = mergeVerification(GOOD, verdicts);
      expect(m.verified).toBe(false);
      expect(m.reason).toBe('verifier checked no point');
      expect(m.counts).toEqual({ confirmed: 0, corrected: 0, unverified: 3 });
    }
  });

  it('leaves points the verifier was not given unverified', () => {
    const many = clone(GOOD);
    many.users[0]!.points = Array.from({ length: 20 }, () => point());
    const m = mergeVerification(many, numberPoints(many).map((p): Verdict => ({ ref: p.ref, verdict: 'CONFIRMED' })));
    expect(m.counts).toEqual({ confirmed: 15, corrected: 0, unverified: 5 });
    expect(m.users[0]!.points.slice(15).every((p) => p.check === 'unverified')).toBe(true);
    expect(m.verified).toBe(true);
  });
});

describe('journey proof', () => {
  const line = (over: Partial<TracePoint>): TracePoint => point({ kind: 'check_call', journey: 'J1', evidence: 'journey J1 call', ...over });

  it('keeps a seen point whose own line carries the journey id, as a whole token', () => {
    expect(proveJourneys([line({})])[0]?.state).toBe('seen');
    const near = proveJourneys([line({ evidence: 'journey J10 call' })])[0];
    expect(near).toMatchObject({ state: 'inferred', why: JOURNEY_UNPROVEN_WHY });
  });

  it('accepts a line that shares a traceId with a line carrying the journey id', () => {
    const [a, b, c] = proveJourneys([
      line({ evidence: 'journey J1 start traceId=abc12345' }),
      line({ kind: 'condition', evidence: 'condition result "traceId":"abc12345"' }),
      line({ kind: 'frequency', evidence: 'frequency traceId=zzz99999' }),
    ]);
    expect([a?.state, b?.state, c?.state]).toEqual(['seen', 'seen', 'inferred']);
    expect(c?.why).toBe(JOURNEY_UNPROVEN_WHY);
  });

  it('does not let a traceId prove a different journey', () => {
    const [a, b] = proveJourneys([line({ evidence: 'journey J1 traceId=abc12345' }), line({ journey: 'J2', evidence: 'no id traceId=abc12345' })]);
    expect(a?.state).toBe('seen');
    expect(b?.state).toBe('inferred');
  });

  it('infers a seen server point with no journey, and leaves client, inferred and not_recorded points alone', () => {
    const out = proveJourneys([
      line({ journey: '' }),
      line({ kind: 'sdk_event', journey: '', evidence: 'event open' }),
      line({ journey: 'J2', state: 'inferred', why: 'node sau', evidence: '' }),
      line({ journey: 'J2', state: 'not_recorded', time: '', source_field: '', evidence: '' }),
    ]);
    expect(out[0]).toMatchObject({ state: 'inferred', why: JOURNEY_MISSING_WHY });
    expect(out.slice(1).map((p) => p.state)).toEqual(['seen', 'inferred', 'not_recorded']);
    expect(proveJourneys(out)).toEqual(out);
  });

  it('accepts a traceId whose quotes are backslash-escaped in the evidence', () => {
    const [a, b] = proveJourneys([line({ evidence: 'journey J1 {\\"trace_id\\":\\"abc12345\\"}' }), line({ kind: 'condition', evidence: 'no id {\\"trace_id\\":\\"abc12345\\"}' })]);
    expect([a?.state, b?.state]).toEqual(['seen', 'seen']);
  });

  it('finds an id next to an underscore', () => {
    expect(proveJourneys([line({ evidence: 'journey_J1_start' })])[0]?.state).toBe('seen');
  });

  it('is applied after verification, on the verifier\'s own evidence, and never changes how many points were checked', () => {
    const traced = clone(GOOD);
    traced.users[0]!.points = [point({ evidence: 'no journey here' }), point({ label: 'ok' }), point({ label: 'third' })];
    const parsed = parseTraceOutput(res(traced), { ...REQ, users: ['u1'] });
    expect(parsed.users[0]?.points.map((p) => p.state)).toEqual(['seen', 'seen', 'seen']);
    const merged = mergeVerification(parsed, [
      { ref: 'u1-p1', verdict: 'CONFIRMED' },
      { ref: 'u1-p2', verdict: 'CORRECTED', time: '1761354999000', source_field: 'ts', evidence: 'line without the id', state: 'seen', why: '' },
      { ref: 'u1-p3', verdict: 'CONFIRMED' },
    ]);
    expect(merged.users[0]?.points.map((p) => [p.state, p.check])).toEqual([['inferred', 'confirmed'], ['inferred', 'corrected'], ['seen', 'confirmed']]);
    expect(merged.users[0]?.points[0]?.why).toBe(JOURNEY_UNPROVEN_WHY);
    expect(merged.counts).toEqual({ confirmed: 2, corrected: 1, unverified: 0 });
    expect(merged.verified).toBe(true);
    expect(mergeVerification(parsed, undefined).users[0]?.points.map((p) => p.state)).toEqual(['inferred', 'seen', 'seen']);
  });

  it('drops an unsafe journey tag and caps the conclusion', () => {
    const traced = clone(GOOD);
    traced.conclusion = ['a', '  ', 'b', 'c', 'd', 'e'];
    traced.users[0]!.points = [point({ journey: 'a b<script>' })];
    const parsed = parseTraceOutput(res(traced), { ...REQ, users: ['u1'] });
    expect(parsed.conclusion).toEqual(['a', 'b', 'c', 'd']);
    expect(parsed.users[0]?.points[0]?.journey).toBe('');
    expect(mergeVerification(parsed, undefined).users[0]?.points[0]).toMatchObject({ state: 'inferred', why: JOURNEY_MISSING_WHY });
  });

  it('blanks a journey tag that is the campaign, a requested user or a role id', () => {
    const traced = clone(GOOD);
    traced.users[0]!.points = [point({ journey: 'CAMP' }), point({ journey: 'u1' }), point({ journey: 'role-1' }), point({ journey: 'J1' })];
    const both = parseTraceOutput(res(traced), { ...REQ, target: 'CAMP', journey: 'J1', users: ['u1'] });
    expect(both.users[0]?.points.map((p) => p.journey)).toEqual(['', '', '', 'J1']);
    const unknown = parseTraceOutput(res(traced), { ...REQ, target: 'CAMP', users: ['u1'] });
    expect(unknown.users[0]?.points[0]?.journey).toBe('CAMP');
    const campaign = parseTraceOutput(res(traced), { ...REQ, target: 'CAMP', kind: 'campaign', users: ['u1'] });
    expect(campaign.users[0]?.points[0]?.journey).toBe('');
  });

  it('keeps publish and subscribe on the client row and checks their channel', () => {
    expect(rowOf('publish')).toBe('client');
    expect(rowOf('subscribe')).toBe('client');
    const traced = clone(GOOD);
    traced.users[0]!.points = [
      point({ kind: 'publish', journey: '', channel: 'role:gamea:U1:R1:env', evidence: 'publish role:gamea:U1:R1:env' }),
      point({ kind: 'subscribe', journey: '', channel: '', state: 'not_recorded', time: '', source_field: '', evidence: '' }),
      point({ kind: 'subscribe', journey: '', channel: '' }),
      point({ kind: 'subscribe', journey: '', channel: 'bad channel<b>' }),
      point({ kind: 'send', channel: 'role:gamea:U1:R1:env' }),
    ];
    const parsed = parseTraceOutput(res(traced), { ...REQ, users: ['u1'] });
    expect(parsed.users[0]?.points.map((p) => p.state)).toEqual(['seen', 'not_recorded', 'inferred', 'inferred', 'inferred']);
    const merged = mergeVerification(parsed, undefined);
    expect(merged.users[0]?.points.map((p) => p.state)).toEqual(['seen', 'not_recorded', 'inferred', 'inferred', 'inferred']);
  });

  it('demotes a channel point whose evidence does not name the channel, as a whole token', () => {
    const ch = (over: Partial<TracePoint>): TracePoint => point({ kind: 'subscribe', journey: '', channel: 'role:ga:U1:R1:e', evidence: 'subscribe role:ga:U1:R1:e ok', ...over });
    const out = proveChannels([ch({}), ch({ evidence: 'subscribed ok' }), ch({ evidence: 'subscribe role:ga:U1:R1:env' }), ch({ channel: '', state: 'seen' }), ch({ state: 'not_recorded', channel: '', time: '', evidence: '', source_field: '' }), point({ evidence: 'no channel here' })]);
    expect(out.map((p) => p.state)).toEqual(['seen', 'inferred', 'inferred', 'inferred', 'not_recorded', 'seen']);
    expect(out[1]?.why).toBe(CHANNEL_UNPROVEN_WHY);
    expect(proveChannels(out)).toEqual(out);
  });

  it('applies the channel proof after verification and lets a verifier turn a channel point into not_recorded', () => {
    const traced = clone(GOOD);
    traced.users[0]!.points = [point({ kind: 'subscribe', journey: '', channel: 'role:ga:U1:R1:e', evidence: 'subscribed ok' }), point({ kind: 'subscribe', journey: '', channel: 'role:ga:U1:R1:e', evidence: 'subscribe role:ga:U1:R1:e' })];
    const parsed = parseTraceOutput(res(traced), { ...REQ, users: ['u1'] });
    const merged = mergeVerification(parsed, [
      { ref: 'u1-p1', verdict: 'CORRECTED', time: '', source_field: '', evidence: '', state: 'not_recorded', why: '' },
      { ref: 'u1-p2', verdict: 'CONFIRMED' },
    ]);
    expect(merged.users[0]?.points[0]).toMatchObject({ state: 'not_recorded', channel: '', check: 'corrected' });
    expect(merged.users[0]?.points[1]).toMatchObject({ state: 'seen', check: 'confirmed' });
    const unproven = mergeVerification(parsed, undefined);
    expect(unproven.users[0]?.points[0]).toMatchObject({ state: 'inferred', why: CHANNEL_UNPROVEN_WHY });
  });

  it('accepts channel names with Centrifugo characters and refuses whitespace and markup', () => {
    const traced = clone(GOOD);
    traced.users[0]!.points = ['$role:ga:U1#R1', 'a/b,c', 'x'.repeat(300)].map((channel) => point({ kind: 'publish', journey: '', channel, evidence: channel }));
    traced.users[0]!.points.push(point({ kind: 'publish', journey: '', channel: 'a b', evidence: 'a b' }), point({ kind: 'publish', journey: '', channel: 'x'.repeat(301), evidence: 'x' }));
    const parsed = parseTraceOutput(res(traced), { ...REQ, users: ['u1'] });
    expect(parsed.users[0]?.points.map((p) => p.state)).toEqual(['seen', 'seen', 'seen', 'inferred', 'inferred']);
  });

  it('requires the channel field in the trace contract', () => {
    const noChannel = clone(GOOD) as unknown as { users: Array<{ points: Array<Record<string, unknown>> }> };
    delete noChannel.users[0]!.points[0]!['channel'];
    expect(() => parseTraceOutput(res(noChannel), REQ)).toThrow('trace result does not match the contract');
  });

  it('puts delivered on the client row', () => {
    expect(['delivered', 'sdk_event', 'inbox'].map((k) => rowOf(k as TracePoint['kind']))).toEqual(['client', 'client', 'client']);
    expect(rowOf('send')).toBe('server');
  });

  it('asks the model for a short label in the trace contract', () => {
    expect(JSON.stringify(IAM_TRACE_SCHEMA)).toContain('a short name of at most 24 characters');
    expect(JSON.stringify(IAM_TRACE_SCHEMA)).not.toContain('at most 80 characters');
  });

  it('requires journey, outcome and conclusion in the trace contract', () => {
    const noJourney = clone(GOOD) as unknown as { users: Array<{ points: Array<Record<string, unknown>> }> };
    delete noJourney.users[0]!.points[0]!['journey'];
    expect(() => parseTraceOutput(res(noJourney), REQ)).toThrow('trace result does not match the contract');
    const badOutcome = clone(GOOD) as unknown as { users: Array<{ points: Array<Record<string, unknown>> }> };
    badOutcome.users[0]!.points[0]!['outcome'] = 'maybe';
    expect(() => parseTraceOutput(res(badOutcome), REQ)).toThrow('trace result does not match the contract');
    const { conclusion: _dropped, ...noConclusion } = GOOD;
    expect(() => parseTraceOutput(res(noConclusion), REQ)).toThrow('trace result does not match the contract');
  });
});
