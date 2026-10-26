// A synthetic trace shaped like a real one: one player asked for by both ids, a requested journey that sent the IAM and
// was later blocked by frequency (repeats collapse, the day changes), a second journey that blocked the player at every
// event, one point whose journey is only inferred, and a client lane. Every id here is made up.
import type { CheckedPoint, IamTraceRequest, MergedTrace } from '../../src/capability/iam-trace-schema.js';

export const CAMPAIGN = '9000000000000002800';
export const JOURNEY = '9000000000000002368';
export const OTHER_JOURNEY = '9000000000000007184';
export const ROLE_ID = 'RID-TEST-01';
export const USER_ID = '1100000000000000001';

export const PUBLISHED = `role:gamea:${USER_ID}:${ROLE_ID}:env-test`;
export const SUBSCRIBED_ROLE = `role:gameb:${USER_ID}:${ROLE_ID}:env-test`;
export const SUBSCRIBED_USER = `user:gameb:${USER_ID}`;

export const SAMPLE_REQUEST: IamTraceRequest = { target: CAMPAIGN, journey: JOURNEY, users: [ROLE_ID, USER_ID], since: '24h', window: '24 giờ gần nhất' };

type Spec = Pick<CheckedPoint, 'kind' | 'label'> & Partial<CheckedPoint>;
let n = 0;
const point = (spec: Spec): CheckedPoint => {
  n += 1;
  const state = spec.state ?? 'seen';
  const journey = spec.journey ?? JOURNEY;
  return {
    journey,
    outcome: 'info',
    channel: '',
    time: '',
    source_field: state === 'not_recorded' ? '' : '_time',
    evidence: state === 'seen' ? `line ${n} for journey ${journey} traceId=trace-${n}` : '',
    why: '',
    ref: `p${n}`,
    check: 'unverified',
    state,
    ...spec,
  };
};

const server = (): CheckedPoint[] => [
  point({ kind: 'trigger', label: 'Run bắt đầu', time: '2026-10-25T03:28:15.000Z', check: 'confirmed' }),
  point({ kind: 'check_call', label: 'GameAPI role enrich', time: '2026-10-25T03:28:15.400Z' }),
  point({ kind: 'condition', label: 'Điều kiện', outcome: 'pass', time: '2026-10-25T03:28:16.500Z', source_field: 'ts', check: 'confirmed' }),
  point({ kind: 'frequency', label: 'Tần suất', outcome: 'pass', time: '2026-10-25T03:28:16.600Z' }),
  point({ kind: 'send', label: 'Gửi IAM', outcome: 'pass', time: '2026-10-25T03:28:16.700Z', check: 'confirmed' }),
  point({ kind: 'frequency', label: 'Chặn tần suất', outcome: 'block', time: '2026-10-25T05:22:00.000Z' }),
  point({ kind: 'frequency', label: 'Chặn tần suất', outcome: 'block', time: '2026-10-25T05:22:00.800Z' }),
  point({ kind: 'frequency', label: 'Chặn tần suất', outcome: 'block', time: '2026-10-25T05:22:09.000Z' }),
  point({ kind: 'wait_end', label: 'Hết wait', time: '2026-10-26T06:26:00.000Z' }),
  point({ kind: 'trigger', label: 'Run bắt đầu', journey: OTHER_JOURNEY, time: '2026-10-25T05:20:01.000Z' }),
  point({ kind: 'condition', label: 'Loại: event A', journey: OTHER_JOURNEY, outcome: 'block', time: '2026-10-25T06:20:01.000Z' }),
  point({ kind: 'condition', label: 'Loại: event B', journey: OTHER_JOURNEY, outcome: 'block', time: '2026-10-25T06:23:54.000Z' }),
  point({ kind: 'condition', label: 'Loại: event B', journey: OTHER_JOURNEY, outcome: 'block', time: '2026-10-25T06:23:54.500Z' }),
  point({ kind: 'condition', label: 'Loại: event C', journey: OTHER_JOURNEY, outcome: 'block', time: '2026-10-25T06:57:43.000Z' }),
  point({ kind: 'check_call', label: 'Gọi country gate', journey: OTHER_JOURNEY, state: 'inferred', why: 'dòng country gate không ghi journeyId; gán theo game và market', time: '2026-10-25T06:20:00.500Z', evidence: 'country gate line' }),
];

const client = (): CheckedPoint[] => [
  point({ kind: 'delivered', label: 'Ack delivered', state: 'not_recorded', journey: '' }),
  point({ kind: 'publish', label: 'Publish kênh', journey: '', channel: PUBLISHED, time: '2026-10-25T03:28:16.900Z', evidence: `publish ${PUBLISHED}` }),
  point({ kind: 'subscribe', label: 'SDK subscribe', journey: '', channel: SUBSCRIBED_USER, time: '2026-10-25T04:42:24.000Z', evidence: `subscribe ${SUBSCRIBED_USER}` }),
  point({ kind: 'subscribe', label: 'SDK subscribe', journey: '', channel: SUBSCRIBED_ROLE, time: '2026-10-25T04:43:43.000Z', evidence: `subscribe ${SUBSCRIBED_ROLE}` }),
  point({ kind: 'sdk_event', label: 'received', journey: '', time: '2026-10-25T03:28:19.000Z', evidence: 'tracking received' }),
  point({ kind: 'sdk_event', label: 'open', journey: '', time: '2026-10-25T03:28:44.000Z', evidence: 'tracking open' }),
  point({ kind: 'inbox', label: 'Inbox mark-read', journey: '', time: '2026-10-25T03:29:02.000Z', evidence: 'PUT inbox read' }),
];

export const sampleTrace = (): MergedTrace => {
  n = 0;
  const a = [...server(), ...client()];
  n = 0;
  const b = [...server(), ...client()];
  return {
    finding: 'Journey …2368 chạy trọn và gửi IAM lúc 10:28:16; journey …7184 loại user ở mọi event vì quốc gia OT.',
    conclusion: [
      'Journey …2368 gửi IAM lúc 10:28:16, client nhận lúc 10:28:19 và mở lúc 10:28:44.',
      'Journey …7184 loại user ở mọi event vì quốc gia OT.',
      'Không ghi nhận ack delivered của message-delivery.',
    ],
    notes: ['Số liệu chỉ lấy từ log của bốn công cụ iam-trace.'],
    verified: true,
    counts: { confirmed: 3, corrected: 0, unverified: 25 },
    users: [
      { id: ROLE_ID, user_id: USER_ID, role_id: ROLE_ID, points: a },
      { id: USER_ID, user_id: USER_ID, role_id: ROLE_ID, points: b },
    ],
  };
};
