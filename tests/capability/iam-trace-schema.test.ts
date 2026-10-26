import { describe, expect, it } from 'vitest';
import {
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
  parseTraceRequest,
  parseVerifyOutput,
  pointProblem,
  type TracePoint,
  type TraceResult,
  type Verdict,
  verifierPoints,
  verifierSince,
} from '../../src/capability/iam-trace-schema.js';
import type { RunResult } from '../../src/runner/run.js';

const res = (structured: unknown, extra: Partial<RunResult> = {}): RunResult => ({ isError: false, text: '', structured, denials: [], toolUses: [], durationMs: 1, ...extra });
const REQ: IamTraceRequest = { target: 'C1', users: ['u1', 'r2'], since: '24h', window: '24 giờ gần nhất' };
const point = (over: Partial<TracePoint> = {}): TracePoint => ({ kind: 'trigger', label: 'trigger', time: '1761354123456', source_field: '_time', evidence: 'journey workflow executed', state: 'seen', why: '', ...over });
const GOOD: TraceResult = {
  status: 'done',
  finding: 'IAM đã gửi.',
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

describe('parseTraceRequest', () => {
  const now = new Date('2026-10-25T05:00:00Z'); // 12:00 ICT

  it('parses a target and users with the default window', () => {
    const { request, missing } = parseTraceRequest('C123 u1,r2', now);
    expect(missing).toEqual([]);
    expect(request).toEqual({ target: 'C123', users: ['u1', 'r2'], since: '24h', window: '24 giờ gần nhất' });
    expect(request?.timeFilter).toBeUndefined();
  });

  it('windows a datetime from 30 minutes before to 3 hours after, clipped to now', () => {
    const { request, missing } = parseTraceRequest('C123 u1, r2  25/10 09:30', now);
    expect(missing).toEqual([]);
    expect(request?.users).toEqual(['u1', 'r2']);
    expect(request?.at?.toISOString()).toBe('2026-10-25T02:30:00.000Z');
    expect(request?.since).toBe('4h');
    expect(request?.timeFilter).toBe('_time:(2026-10-25T02:00:00Z, 2026-10-25T05:00:00Z)');
    expect(request?.windowStart?.toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(request?.windowEnd?.toISOString()).toBe('2026-10-25T05:00:00.000Z');
    expect(request?.window).toContain('25/10 09:30');
  });

  it('names what is missing', () => {
    expect(parseTraceRequest('', now)).toEqual({ missing: [MISSING_TARGET, MISSING_USERS] });
    expect(parseTraceRequest('C123', now)).toEqual({ missing: [MISSING_USERS] });
  });

  it('caps the users', () => {
    expect(parseTraceRequest('C123 u1,u2,u3,u4,u5,u6', now).missing).toContain('tối đa 5 userId/roleId mỗi lần');
  });

  it('de-duplicates users in order', () => {
    expect(parseTraceRequest('C123 u2,u1,u2', now).request?.users).toEqual(['u2', 'u1']);
  });

  it('rejects an id with other characters', () => {
    const { request, missing } = parseTraceRequest('C123 u1,hôm', now);
    expect(request).toBeUndefined();
    expect(missing.some((m) => m.includes('"hôm" không hợp lệ'))).toBe(true);
  });

  it('takes users only from the first comma-separated token and ignores trailing words', () => {
    const { request, missing } = parseTraceRequest('C123 u1 hôm qua giúp mình', now);
    expect(missing).toEqual([]);
    expect(request?.users).toEqual(['u1']);
    expect(request?.since).toBe('24h');
  });

  it('rejects a datetime that does not exist or is outside the retention', () => {
    expect(parseTraceRequest('C123 u1 31/02 09:00', now).missing.join('\n')).toContain('không hợp lệ (dd/mm hh:mm)');
    expect(parseTraceRequest('C123 u1 25/10 24:00', now).missing.join('\n')).toContain('không hợp lệ (dd/mm hh:mm)');
    expect(parseTraceRequest('C123 u1 10/10 09:00', now).missing.join('\n')).toContain('trong 7 ngày gần nhất');
    expect(parseTraceRequest('C123 u1 26/10 09:00', now).missing.join('\n')).toContain('trong 7 ngày gần nhất');
  });

  it('keeps since within the retention for the oldest accepted datetime', () => {
    const { request } = parseTraceRequest('C123 u1 18/10 15:00', now); // 165h before now
    expect(request?.since).toBe('167h');
    expect(parseTraceRequest('C123 u1 18/10 14:59', now).missing.join('\n')).toContain('trong 7 ngày gần nhất');
  });

  it('finds the datetime anywhere after the users, with trailing words', () => {
    for (const text of ['C123 u1 25/10 09:30.', 'C123 u1 25/10 09:30 nhé', 'C123 u1 25/10 09:30 giúp em', 'C123 u1 lúc 25/10 9:30 nhé', 'C123 u1 25/10 09:30:45', 'C123 u1 25/10/2026 09:30']) {
      const { request, missing } = parseTraceRequest(text, now);
      expect(missing, text).toEqual([]);
      expect(request?.at?.toISOString(), text).toBe('2026-10-25T02:30:00.000Z');
      expect(request?.timeFilter, text).toBe('_time:(2026-10-25T02:00:00Z, 2026-10-25T05:00:00Z)');
    }
    expect(parseTraceRequest('C123 u1 25/10/2025 09:30', now).missing.join('\n')).toContain('trong 7 ngày gần nhất');
  });

  it('asks for dd/mm hh:mm when a date or time cannot be read, instead of falling back to 24 hours', () => {
    for (const text of ['C123 u1 25/10', 'C123 u1 09:30', 'C123 u1 lúc 9h30', 'C123 u1 25/10 9h30', 'C123 u1 hôm 25/10 nhé', 'C123 u1 25/10, 09:30']) {
      const { request, missing } = parseTraceRequest(text, now);
      expect(request, text).toBeUndefined();
      expect(missing.join('\n'), text).toContain('dd/mm hh:mm');
    }
    expect(parseTraceRequest('C123 u1 25/13 09:30', now).missing.join('\n')).toContain('không hợp lệ (dd/mm hh:mm)');
  });

  it('says a time later today is in the future', () => {
    for (const text of ['C123 u1 25/10 15:00', 'C123 u1 25/10/2026 15:00']) {
      const out = parseTraceRequest(text, now).missing.join('\n');
      expect(out, text).toContain('tương lai');
      expect(out, text).not.toContain('7 ngày');
    }
  });

  it('asks for commas when a second id follows the users', () => {
    for (const text of ['C1 u1 u2', 'C1 u1 1002', 'C1 u1 u2.', 'C1 u1,u2 u3 25/10 09:30']) {
      const { request, missing } = parseTraceRequest(text, now);
      expect(request, text).toBeUndefined();
      expect(missing.join('\n'), text).toContain('dấu phẩy');
    }
    for (const text of ['C1 u1 24h', 'C1 u1 hôm qua', 'C1 u1 25/10 09:30']) expect(parseTraceRequest(text, now).missing, text).toEqual([]);
  });

  it('reads a datetime in place of the users as missing users', () => {
    expect(parseTraceRequest('C123 25/10 09:30', now)).toEqual({ missing: [MISSING_USERS] });
  });

  it('takes the previous year when the date is ahead in the current one', () => {
    const { request } = parseTraceRequest('C1 u1 31/12 23:00', new Date('2026-01-02T00:00:00Z'));
    expect(request?.at?.toISOString()).toBe('2025-12-31T16:00:00.000Z');
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

  it('cuts a user to 40 points with one note', () => {
    const many = clone(GOOD);
    many.users[0]!.points = Array.from({ length: 45 }, () => point());
    const t = parseTraceOutput(res(many), { ...REQ, users: ['u1'] });
    expect(t.users[0]?.points).toHaveLength(40);
    expect(t.notes).toEqual(['Chỉ hiển thị 40 mốc đầu cho mỗi user.']);
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
    expect(t.users[0]!.points[2]?.evidence).toBe('journey workflow executed');
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
    expect(IAM_TRACE_SCHEMA['required']).toEqual(['status', 'finding', 'users', 'missing', 'notes']);
    expect(IAM_VERIFY_SCHEMA['required']).toEqual(['status', 'verdicts', 'notes']);
  });
});

describe('mergeVerification', () => {
  const corrected: Verdict = { ref: 'u1-p2', verdict: 'CORRECTED', time: '1761354999000', source_field: 'ts', evidence: 'new line', state: 'seen', why: '' };
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
    expect(p2).toEqual({ ...traced('u1-p2'), time: '1761354999000', source_field: 'ts', evidence: 'new line', state: 'seen', why: '', ref: 'u1-p2', check: 'corrected' });
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
