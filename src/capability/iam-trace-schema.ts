// The iam_trace contract: the request parsed in code, the trace and verifier JSON schemas with their parsers, ICT
// time conversion, and the deterministic merge of the verifier's verdicts. Pure functions only.
import type { RunResult } from '../runner/run.js';
import { matches } from './kb-answer.js';

export const POINT_KINDS = ['trigger', 'wait_end', 'check_call', 'condition', 'frequency', 'send', 'delivered', 'sdk_event', 'inbox'] as const;
export type PointKind = (typeof POINT_KINDS)[number];
export const POINT_STATES = ['seen', 'inferred', 'not_recorded'] as const;
export type PointState = (typeof POINT_STATES)[number];
export const POINT_OUTCOMES = ['pass', 'block', 'info'] as const;
export type PointOutcome = (typeof POINT_OUTCOMES)[number];

export function rowOf(kind: PointKind): 'server' | 'client' {
  return kind === 'delivered' || kind === 'sdk_event' || kind === 'inbox' ? 'client' : 'server';
}

export const MAX_USERS = 5;
export const MAX_POINTS_PER_USER = 60;
export const MAX_CONCLUSION = 4;
export const MAX_CONCLUSION_CHARS = 250;
export const RETENTION_HOURS = 168;
export const ICT_OFFSET_MS = 7 * 3_600_000;
export const MISSING_TARGET = 'mã campaign hoặc journey (campaignId hoặc journeyId)';
export const MISSING_USERS = 'ít nhất một userId hoặc roleId (nhiều mã cách nhau bằng dấu phẩy)';

const HOUR_MS = 3_600_000;

// windowStart/windowEnd exist only with a datetime; timeFilter carries the same bounds as text.
// journey is the journey id when the message carried both a campaign and a journey id (target is then the campaign).
export type IamTraceRequest = { target: string; journey?: string; users: string[]; at?: Date; since: string; timeFilter?: string; windowStart?: Date; windowEnd?: Date; window: string };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/u;
// dd/mm[/yyyy] h:mm[:ss] anywhere after the users, followed by a space, punctuation or the end.
const DATETIME_RE = /(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})(?::\d{2})?(?=$|[\s.,;!?])/u;
const DATE_LIKE = /\d{1,2}\/\d{1,2}/u;
const TIME_LIKE = /\d{1,2}[:h]\d{2}/u;
const DATE_OR_TIME_TOKEN = /^(?:\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d{1,2}[:h]\d{2}(?::\d{2})?)$/u;
const DURATION_TOKEN = /^\d{1,3}[hdmp]$/u;
export const MISSING_DATETIME = 'thời điểm theo dạng dd/mm hh:mm (ví dụ 25/10 09:30), có cả ngày và giờ';
export const MISSING_COMMAS = 'các userId/roleId phải cách nhau bằng dấu phẩy, không phải dấu cách (ví dụ u1,u2)';

// A pasted bug report: a campaign link or id, a journeyInfo id, and UID:/RID: lines. Only values of these shapes are
// read; the surrounding words never reach the request.
const CAMPAIGN_RES = [/\/campaigns?\/(\d{6,25})\b/iu, /campaign[\s_-]?id"?\s*[:=#]\s*"?(\d{6,25})/iu];
const JOURNEY_RES = [/\/journeys?\/(\d{6,25})\b/iu, /journeyInfo"?\s*[:=]\s*\{\s*"?id"?\s*[:=]\s*"?(\d{6,25})/iu, /journey[\s_-]?id"?\s*[:=#]\s*"?(\d{6,25})/iu];
const USER_LABEL_RE = /\b(?:uid|rid|user[\s_-]?id|role[\s_-]?id)"?\s*[:=#]\s*"?([^\s"',;]+(?:"?\s*,\s*"?[^\s"',;]+)*)/giu;

function firstMatch(res: RegExp[], text: string): string | undefined {
  for (const re of res) {
    const m = re.exec(text);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}

function freeForm(text: string): { target: string; journey?: string; users: string[] } | undefined {
  const campaign = firstMatch(CAMPAIGN_RES, text);
  const journey = firstMatch(JOURNEY_RES, text);
  const users = [...new Set([...text.matchAll(USER_LABEL_RE)].flatMap((m) => (m[1] ?? '').split(/"?\s*,\s*"?/u)).filter((u) => u !== ''))];
  if (campaign === undefined && journey === undefined && users.length === 0) return undefined;
  const target = campaign ?? journey ?? '';
  return { target, ...(campaign !== undefined && journey !== undefined && journey !== campaign ? { journey } : {}), users };
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');

function ictMs(y: number, mo: number, d: number, h: number, mi: number): number | undefined {
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const t = new Date(local);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi) return undefined;
  return local - ICT_OFFSET_MS;
}

// The datetime found after the users, or the need_input entry explaining why it cannot be used.
function requestTime(rest: string, now: Date, lenient = false): { at?: number; x?: string; problem?: string } {
  const dt = DATETIME_RE.exec(rest);
  if (!dt) return !lenient && (DATE_LIKE.test(rest) || TIME_LIKE.test(rest)) ? { problem: MISSING_DATETIME } : {};
  const [d, mo, h, mi] = [dt[1], dt[2], dt[4], dt[5]].map(Number) as [number, number, number, number];
  const x = `${dt[1]}/${dt[2]}${dt[3] !== undefined ? `/${dt[3]}` : ''} ${dt[4]}:${dt[5]}`;
  const year = dt[3] !== undefined ? Number(dt[3]) : new Date(now.getTime() + ICT_OFFSET_MS).getUTCFullYear();
  let at = ictMs(year, mo, d, h, mi);
  if (at === undefined) return { problem: `thời điểm ${x} không hợp lệ (dd/mm hh:mm)` };
  if (at > now.getTime()) {
    const today = new Date(now.getTime() + ICT_OFFSET_MS);
    if (dt[3] !== undefined || (today.getUTCDate() === d && today.getUTCMonth() === mo - 1)) {
      return { problem: `thời điểm ${x} còn ở tương lai (dd/mm hh:mm, giờ Việt Nam)` };
    }
    at = ictMs(year - 1, mo, d, h, mi);
  }
  if (at === undefined || now.getTime() - at > (RETENTION_HOURS - 3) * HOUR_MS) return { problem: `thời điểm ${x} phải trong 7 ngày gần nhất (kho log chỉ giữ 7 ngày)` };
  return { at, x };
}

// iam_trace <campaignId|journeyId> <userId|roleId>[,...] [dd/mm hh:mm], or a pasted message with a campaign link or id,
// a journeyInfo id and UID:/RID: lines. In the short form users come only from the first token after the target
// (spaces around commas allowed); other words are ignored, except an id-like word right after the users, which is
// taken for a user missing its comma.
export function parseTraceRequest(raw: string, now: Date): { request?: IamTraceRequest; missing: string[] } {
  const text = raw.replace(/\s+/gu, ' '); // one space per run: the patterns below then stay linear on long whitespace
  const free = freeForm(text);
  const tokens = text.replace(/\s*,\s*/gu, ',').trim().split(/\s+/u).filter((t) => t !== '');
  const second = tokens[1] ?? '';
  const list = DATE_OR_TIME_TOKEN.test(second) ? '' : second;
  const rest = free !== undefined ? [text] : tokens.slice(list === '' ? 1 : 2);
  const target = free !== undefined ? free.target : (tokens[0] ?? '');
  const journey = free?.journey;
  const users = free !== undefined ? free.users : [...new Set(list.split(',').filter((u) => u !== ''))];
  const missing: string[] = [];
  if (target === '') missing.push(MISSING_TARGET);
  if (users.length === 0) missing.push(MISSING_USERS);
  for (const token of [target, ...(journey !== undefined ? [journey] : []), ...users]) {
    if (token !== '' && !ID_RE.test(token)) missing.push(`mã "${token.slice(0, 64)}" không hợp lệ (chỉ gồm chữ, số và _ . : @ -)`);
  }
  if (users.length > MAX_USERS) missing.push(`tối đa ${MAX_USERS} userId/roleId mỗi lần`);
  const next = (rest[0] ?? '').replace(/[.,;!?]+$/u, '');
  if (free === undefined && list !== '' && ID_RE.test(next) && /\d/u.test(next) && !DATE_OR_TIME_TOKEN.test(next) && !DURATION_TOKEN.test(next)) missing.push(MISSING_COMMAS);

  const { at, x, problem } = requestTime(rest.join(' '), now, free !== undefined);
  if (problem !== undefined) missing.push(problem);
  if (missing.length > 0) return { missing };
  if (at === undefined) return { request: { target, ...(journey !== undefined ? { journey } : {}), users, since: '24h', window: '24 giờ gần nhất' }, missing };

  const start = at - 30 * 60_000;
  const end = Math.min(at + 3 * HOUR_MS, now.getTime());
  return {
    request: {
      target,
      ...(journey !== undefined ? { journey } : {}),
      users,
      at: new Date(at),
      since: `${Math.min(RETENTION_HOURS, Math.ceil((now.getTime() - start) / HOUR_MS) + 1)}h`,
      timeFilter: `_time:(${iso(start)}, ${iso(end)})`,
      windowStart: new Date(start),
      windowEnd: new Date(end),
      window: `quanh ${x ?? ''} ICT (từ 30 phút trước đến 3 giờ sau)`,
    },
    missing,
  };
}

// The verifier runs after the trace, so its look-back grows by the time already spent.
export function verifierSince(since: string, elapsedMs: number): string {
  return `${Math.min(RETENTION_HOURS, Number.parseInt(since, 10) + Math.floor(elapsedMs / HOUR_MS) + 1)}h`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/u;

function isoMs(s: string): number | undefined {
  const m = ISO_RE.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const local = Date.UTC(y, mo - 1, d, h, mi, sec, Number((m[7] ?? '').padEnd(3, '0').slice(0, 3)));
  const t = new Date(local);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== sec) return undefined;
  const zone = m[8] as string;
  if (zone === 'Z') return local;
  const digits = zone.slice(1).replace(':', '');
  const oh = Number(digits.slice(0, 2));
  const om = Number(digits.slice(2));
  if (oh > 23 || om > 59) return undefined;
  return local - (zone[0] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
}

// audee converts every time itself; the model only copies the raw value.
export function ictTime(raw: string): { ms: number; text: string } | undefined {
  const s = raw.trim();
  let ms: number | undefined;
  if (/^\d{13}$/u.test(s)) ms = Number(s);
  else if (/^(?:\d{16}|\d{19})$/u.test(s)) ms = Number(s.slice(0, 13)); // micro/nanoseconds: Number() of the whole loses precision
  else if (/^\d{10}(?:\.\d{1,6})?$/u.test(s)) ms = Math.round(Number(s) * 1000);
  else ms = isoMs(s);
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms + ICT_OFFSET_MS);
  const two = (n: number): string => String(n).padStart(2, '0');
  const frac = d.getUTCMilliseconds();
  const text = `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}${frac !== 0 ? `.${String(frac).padStart(3, '0')}` : ''}`;
  return { ms, text };
}

const TIME_DESC = 'the time value copied verbatim: a time printed inside the log message text when there is one, else the entry time; empty when not_recorded';
const SOURCE_DESC = 'where the time came from: the name printed in the message text (for example ts), or _time for the entry time; empty when not_recorded';
const EVIDENCE_DESC = 'one log line verbatim, at most 600 characters, token/key/secret/password values replaced by <redacted>; empty when not_recorded';
const WHY_DESC = 'inferred only: why, at most 300 characters; else empty';
const JOURNEY_DESC = 'the id of the journey this point belongs to, as printed in the log line or in a line with the same traceId; empty for delivered, sdk_event and inbox points and when no journey id is known';
const OUTCOME_DESC = 'block = the user stops at this point (condition false, frequency rejected, excluded); pass = a check passed or an action succeeded; info = neutral';
const stringItem = { type: 'string' };
const states = { type: 'string', enum: [...POINT_STATES] };

const POINT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'label', 'journey', 'outcome', 'time', 'source_field', 'evidence', 'state', 'why'],
  properties: {
    kind: { type: 'string', enum: [...POINT_KINDS] },
    journey: { type: 'string', description: JOURNEY_DESC },
    outcome: { type: 'string', enum: [...POINT_OUTCOMES], description: OUTCOME_DESC },
    label: { type: 'string', description: 'at most 80 characters' },
    time: { type: 'string', description: TIME_DESC },
    source_field: { type: 'string', description: SOURCE_DESC },
    evidence: { type: 'string', description: EVIDENCE_DESC },
    state: states,
    why: { type: 'string', description: WHY_DESC },
  },
};

export const IAM_TRACE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'finding', 'conclusion', 'users', 'missing', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'need_input', 'failed'] },
    finding: { type: 'string', description: '1-2 Vietnamese sentences, at most 300 characters' },
    conclusion: { type: 'array', items: stringItem, description: `2-4 Vietnamese bullets, each at most ${MAX_CONCLUSION_CHARS} characters, what the trace shows` },
    users: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'user_id', 'role_id', 'points'],
        properties: { id: { type: 'string' }, user_id: { type: 'string' }, role_id: { type: 'string' }, points: { type: 'array', items: POINT_SCHEMA } },
      },
    },
    missing: { type: 'array', items: stringItem },
    notes: { type: 'array', items: stringItem },
  },
};

const CORRECTED_ONLY = 'CORRECTED only (omit for CONFIRMED): ';

// A CONFIRMED verdict is just {ref, verdict}; the correction fields are optional in the schema and audee ignores a
// CORRECTED verdict that lacks them.
export const IAM_VERIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'verdicts', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'failed'] },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'verdict'],
        properties: {
          ref: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'CORRECTED'] },
          time: { type: 'string', description: CORRECTED_ONLY + TIME_DESC },
          source_field: { type: 'string', description: CORRECTED_ONLY + SOURCE_DESC },
          evidence: { type: 'string', description: CORRECTED_ONLY + EVIDENCE_DESC },
          state: { ...states, description: CORRECTED_ONLY + 'the state the logs show' },
          why: { type: 'string', description: CORRECTED_ONLY + WHY_DESC },
        },
      },
    },
    notes: { type: 'array', items: stringItem },
  },
};

export type TracePoint = { kind: PointKind; label: string; journey: string; outcome: PointOutcome; time: string; source_field: string; evidence: string; state: PointState; why: string };
export type TraceUser = { id: string; user_id: string; role_id: string; points: TracePoint[] };
export type TraceResult = { status: 'done' | 'need_input'; finding: string; conclusion: string[]; users: TraceUser[]; missing: string[]; notes: string[] };
export type Verdict = { ref: string; verdict: 'CONFIRMED' | 'CORRECTED'; time?: string; source_field?: string; evidence?: string; state?: PointState; why?: string };

export const INVALID_POINT_WHY = 'bằng chứng không hợp lệ';

// The shape rules every point must meet, traced or corrected. Whether the time parses is the renderer's concern.
export function pointProblem(p: TracePoint): string | undefined {
  if (p.state === 'seen' && p.evidence.trim() === '') return 'seen point has no evidence';
  if (p.state === 'inferred' && p.why.trim() === '') return 'inferred point has no why';
  if (p.state === 'not_recorded' && (p.time.trim() !== '' || p.evidence.trim() !== '')) return 'not_recorded point has a time or evidence';
  return undefined;
}

export const JOURNEY_UNPROVEN_WHY = 'dòng log không ghi journey này và không cùng traceId với dòng nào ghi journey này';
export const JOURNEY_MISSING_WHY = 'mốc này chưa gắn journey';
const TRACE_ID_RE = /trace[_-]?id"?\s*[:=]\s*"?([A-Za-z0-9_-]{6,64})/giu;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// An id as a whole token: "J1" is not found inside "J10".
const mentions = (text: string, id: string): boolean => new RegExp(`(?<![A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`, 'u').test(text);
// Evidence may hold JSON with backslash-escaped quotes.
const traceIdsOf = (text: string): string[] => [...text.replaceAll('\\"', '"').matchAll(TRACE_ID_RE)].map((m) => m[1] as string);

// A server point's journey counts as seen only when its own evidence line carries the journey id, or shares a traceId
// with another point's line that does; otherwise the point is inferred and says why. Idempotent. Applied once, after
// verification: the verifier judges whether a line exists, not which journey it belongs to.
export function proveJourneys<P extends TracePoint>(points: P[]): P[] {
  const traces = new Set<string>();
  for (const p of points) {
    if (p.state === 'seen' && p.journey !== '' && mentions(p.evidence, p.journey)) for (const id of traceIdsOf(p.evidence)) traces.add(`${p.journey}\u0000${id}`);
  }
  return points.map((p) => {
    if (p.state !== 'seen' || rowOf(p.kind) === 'client') return p;
    if (p.journey === '') return { ...p, state: 'inferred', why: JOURNEY_MISSING_WHY };
    if (mentions(p.evidence, p.journey) || traceIdsOf(p.evidence).some((id) => traces.has(`${p.journey}\u0000${id}`))) return p;
    return { ...p, state: 'inferred', why: JOURNEY_UNPROVEN_WHY };
  });
}

export function parseTraceOutput(result: RunResult, request: IamTraceRequest): TraceResult {
  if (result.isError) throw new Error('trace reported an error');
  const s = result.structured;
  if (s === undefined || s === null) throw new Error('trace returned no structured result');
  if (!matches(s, IAM_TRACE_SCHEMA)) throw new Error('trace result does not match the contract');
  const raw = s as Omit<TraceResult, 'status'> & { status: TraceResult['status'] | 'failed' };
  if (raw.status === 'failed') throw new Error('trace session could not finish');
  if (raw.status === 'need_input' && raw.missing.length === 0) throw new Error('trace needs input but does not say what is missing');
  const notes = [...raw.notes];
  const wanted = new Set(request.users);
  const users: TraceUser[] = [];
  for (const u of raw.users) if (wanted.has(u.id) && !users.some((x) => x.id === u.id)) users.push(u);
  if (users.length < raw.users.length) notes.push('Bỏ qua user không có trong yêu cầu hoặc bị lặp.');
  if (raw.status === 'done' && users.length === 0) throw new Error('trace is done but has no users');
  let cut = false;
  const kept = users.slice(0, MAX_USERS);
  const absent = request.users.filter((id) => !kept.some((u) => u.id === id)).length;
  if (raw.status === 'done' && absent > 0) notes.push(`Kết quả thiếu ${absent} trong ${request.users.length} user được yêu cầu.`);
  const out = kept.map((u) => {
    if (u.points.length > MAX_POINTS_PER_USER) cut = true;
    const checked = u.points.slice(0, MAX_POINTS_PER_USER).map((p): TracePoint => {
      const tagged = p.journey === '' || ID_RE.test(p.journey) ? p : { ...p, journey: '' };
      return pointProblem(tagged) === undefined ? tagged : { ...tagged, state: 'inferred', why: INVALID_POINT_WHY };
    });
    return { ...u, points: checked };
  });
  if (cut) notes.push(`Chỉ hiển thị ${MAX_POINTS_PER_USER} mốc đầu cho mỗi user.`);
  const conclusion = raw.conclusion.map((c) => c.trim()).filter((c) => c !== '').slice(0, MAX_CONCLUSION);
  return { status: raw.status, finding: raw.finding, conclusion, users: out, missing: raw.missing, notes };
}

export function parseVerifyOutput(result: RunResult): Verdict[] {
  if (result.isError) throw new Error('verifier reported an error');
  const s = result.structured;
  if (s === undefined || s === null) throw new Error('verifier returned no structured result');
  if (!matches(s, IAM_VERIFY_SCHEMA)) throw new Error('verifier result does not match the contract');
  const raw = s as { status: 'done' | 'failed'; verdicts: Verdict[] };
  if (raw.status === 'failed') throw new Error('verifier could not finish');
  return raw.verdicts;
}

export type NumberedPoint = TracePoint & { ref: string; user: string };
export type CheckedPoint = TracePoint & { ref: string; check: 'confirmed' | 'corrected' | 'unverified' };
export type MergedTrace = {
  finding: string;
  conclusion: string[];
  notes: string[];
  verified: boolean;
  reason?: string; // set only when the merge itself finds the verification unusable
  users: Array<Omit<TraceUser, 'points'> & { points: CheckedPoint[] }>;
  counts: { confirmed: number; corrected: number; unverified: number };
};

export const MAX_VERIFY_POINTS = 15;

const refOf = (i: number, j: number): string => `u${i + 1}-p${j + 1}`;

export function numberPoints(trace: TraceResult): NumberedPoint[] {
  return trace.users.flatMap((u, i) => u.points.map((p, j) => ({ ...p, ref: refOf(i, j), user: u.id })));
}

// The points handed to the verifier, in a fixed order: seen points first. mergeVerification recomputes the same set,
// so a verdict for any other point is ignored.
export function verifierPoints(points: NumberedPoint[]): NumberedPoint[] {
  return [...points.filter((p) => p.state === 'seen'), ...points.filter((p) => p.state !== 'seen')].slice(0, MAX_VERIFY_POINTS);
}

function corrected(p: TracePoint, v: Verdict): TracePoint | undefined {
  const { time, source_field, evidence, state, why } = v;
  if (time === undefined || source_field === undefined || evidence === undefined || state === undefined || why === undefined) return undefined;
  const c: TracePoint = { ...p, time, source_field, evidence, state, why };
  return pointProblem(c) === undefined ? c : undefined;
}

export function mergeVerification(trace: TraceResult, verdicts: Verdict[] | undefined): MergedTrace {
  const given = new Set(verifierPoints(numberPoints(trace)).map((p) => p.ref));
  const byRef = new Map<string, Verdict>();
  for (const v of verdicts ?? []) if (given.has(v.ref) && !byRef.has(v.ref)) byRef.set(v.ref, v);
  const merge = (apply: boolean): MergedTrace['users'] =>
    trace.users.map((u, i) => ({
      ...u,
      points: proveJourneys(
        u.points.map((p, j): CheckedPoint => {
          const ref = refOf(i, j);
          const v = apply ? byRef.get(ref) : undefined;
          if (v?.verdict === 'CONFIRMED') return { ...p, ref, check: 'confirmed' };
          const c = v?.verdict === 'CORRECTED' ? corrected(p, v) : undefined;
          return c ? { ...c, ref, check: 'corrected' } : { ...p, ref, check: 'unverified' };
        }),
      ),
    }));
  const tally = (users: MergedTrace['users']): MergedTrace['counts'] => {
    const counts = { confirmed: 0, corrected: 0, unverified: 0 };
    for (const u of users) for (const p of u.points) counts[p.check] += 1;
    return counts;
  };
  let users = merge(true);
  let counts = tally(users);
  let reason: string | undefined;
  if (verdicts !== undefined) {
    const checked = counts.confirmed + counts.corrected;
    if (checked === 0) reason = 'verifier checked no point';
    else if (counts.corrected > checked / 2) {
      reason = 'verifier changed most points';
      users = merge(false);
      counts = tally(users);
    }
  }
  return { finding: trace.finding, conclusion: trace.conclusion, notes: trace.notes, verified: counts.confirmed + counts.corrected > 0, ...(reason !== undefined ? { reason } : {}), users, counts };
}
