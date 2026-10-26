// The iam_trace timeline as data, before any markup: same-player users merged, points grouped into one lane per journey
// plus one client lane, ordered, repeats collapsed, gaps and day changes worked out. Pure functions of the merged trace;
// nothing here escapes or draws, the page and the SVG builder do.
import { type CheckedPoint, ICT_OFFSET_MS, type IamTraceRequest, ictTime, type MergedTrace, type PointKind, rowOf } from '../capability/iam-trace-schema.js';

export const KIND_VI: Record<PointKind, string> = {
  trigger: 'Trigger',
  wait_end: 'Hết wait',
  check_call: 'Gọi kiểm tra',
  condition: 'Kết quả điều kiện',
  frequency: 'Frequency check',
  send: 'Gửi IAM',
  delivered: 'Client ack',
  sdk_event: 'SDK tracking',
  inbox: 'App Inbox',
};

export type NodeClass = 'block' | 'check' | 'sent' | 'other' | 'missing';
export type LayoutNode = {
  cls: NodeClass;
  label: string;
  inferred: boolean;
  time: string; // hh:mm:ss, with dd/mm in front when the day differs from the previous node; — or ? without a usable time
  marked: boolean; // the time was printed inside the message, not the log-store time
  sub?: string;
  gap?: string; // time from this node to the next one
  count: number;
};
export type LayoutLane = { title: string; sub: string; nodes: LayoutNode[]; points: CheckedPoint[] };
export type LayoutPlayer = { ids: string[]; userId: string; roleId: string; journeys: LayoutLane[]; client: LayoutLane; points: CheckedPoint[] };

export const UNKNOWN_JOURNEY = 'Journey chưa rõ';
export const CLIENT_LANE = 'Client';

const STATE_RANK = { seen: 0, inferred: 1, not_recorded: 2 } as const;
const CHECK_KINDS = new Set<PointKind>(['check_call', 'condition', 'frequency']);
const two = (n: number): string => String(n).padStart(2, '0');

export function idTail(id: string): string {
  return id.length > 6 ? `…${id.slice(-4)}` : id;
}

function ictParts(ms: number): { date: string; clock: string } {
  const d = new Date(ms + ICT_OFFSET_MS);
  return { date: `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}`, clock: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}` };
}

export function formatGap(ms: number): string {
  const gap = Math.max(0, ms);
  if (gap < 60_000) {
    const s = gap / 1000;
    return s < 10 ? `+${Math.round(s * 10) / 10}s` : `+${Math.floor(s)}s`;
  }
  const min = Math.floor(gap / 60_000);
  if (min < 10) {
    const sec = Math.floor(gap / 1000) % 60;
    return sec > 0 ? `+${min}m${sec}s` : `+${min}m`;
  }
  if (min < 60) return `+${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 > 0 ? `+${h}h${min % 60}m` : `+${h}h`;
  return h % 24 > 0 ? `+${Math.floor(h / 24)}d${h % 24}h` : `+${Math.floor(h / 24)}d`;
}

// "22/10", "22–23/10" or "30/10–01/11".
export function dateRange(fromMs: number, toMs: number): string {
  const a = ictParts(fromMs).date;
  const b = ictParts(toMs).date;
  if (a === b) return a;
  return a.slice(3) === b.slice(3) ? `${a.slice(0, 2)}–${b}` : `${a}–${b}`;
}

const identities = (u: MergedTrace['users'][number]): string[] => [u.id, u.user_id, u.role_id].filter((k) => k !== '');
const differ = (a: string, b: string): boolean => a !== '' && b !== '' && a !== b;

// One player asked for by both ids: the entries share an id, userId or roleId. Two roles of one account (same userId,
// different roleIds) are two players.
function samePlayer(a: MergedTrace['users'][number], b: MergedTrace['users'][number]): boolean {
  if (!identities(a).some((k) => identities(b).includes(k))) return false;
  return !(a.user_id === b.user_id && differ(a.role_id, b.role_id)) && !(a.role_id === b.role_id && differ(a.user_id, b.user_id));
}

// Users that are one player become one entry. A point seen under both ids is kept once (the better state wins); points
// of a single user are never merged with each other.
export function mergePlayers(users: MergedTrace['users']): Array<{ ids: string[]; userId: string; roleId: string; points: CheckedPoint[] }> {
  const group = users.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i] as number)));
  users.forEach((a, i) => users.slice(0, i).forEach((b, j) => samePlayer(a, b) && (group[root(i)] = root(j))));
  const out: Array<{ ids: string[]; userId: string; roleId: string; points: CheckedPoint[]; at: number }> = [];
  const key = (c: CheckedPoint): string => [c.kind, c.journey, c.label, c.outcome, c.time, c.evidence].join('\u0000');
  users.forEach((u, i) => {
    const at = root(i);
    let p = out.find((x) => x.at === at);
    if (p === undefined) out.push((p = { ids: [], userId: '', roleId: '', points: [], at }));
    if (!p.ids.includes(u.id)) p.ids.push(u.id);
    p.userId = p.userId !== '' ? p.userId : u.user_id;
    p.roleId = p.roleId !== '' ? p.roleId : u.role_id;
    const earlier = p.points.length;
    for (const c of u.points) {
      const i = p.points.slice(0, earlier).findIndex((x) => key(x) === key(c));
      if (i < 0) p.points.push(c);
      else if (STATE_RANK[c.state] < STATE_RANK[(p.points[i] as CheckedPoint).state]) p.points[i] = c;
    }
  });
  return out.map(({ ids, userId, roleId, points }) => ({ ids, userId, roleId, points }));
}

const msOf = (p: CheckedPoint): number | undefined => (p.state === 'not_recorded' ? undefined : ictTime(p.time)?.ms);

type Timed = { p: CheckedPoint; ms: number | undefined };

// Timed points by time (stable: equal instants keep the model's order); a point without a time stays right after the
// timed point that preceded it in the model's order.
function order(points: CheckedPoint[]): Timed[] {
  const items: Timed[] = points.map((p) => ({ p, ms: msOf(p) }));
  const after = new Map<Timed | undefined, Timed[]>();
  let last: Timed | undefined;
  for (const it of items) {
    if (it.ms !== undefined) last = it;
    else after.set(last, [...(after.get(last) ?? []), it]);
  }
  const timed = items.filter((it) => it.ms !== undefined).sort((a, b) => (a.ms as number) - (b.ms as number));
  return [...(after.get(undefined) ?? []), ...timed.flatMap((it) => [it, ...(after.get(it) ?? [])])];
}

function classOf(p: CheckedPoint): NodeClass {
  if (p.state === 'not_recorded') return 'missing';
  if (p.outcome === 'block') return 'block';
  if (CHECK_KINDS.has(p.kind)) return 'check';
  return p.kind === 'send' ? 'sent' : 'other';
}

const labelOf = (p: CheckedPoint): string => (p.label.trim() === '' ? KIND_VI[p.kind] : p.label.trim());
const sameNode = (a: CheckedPoint, b: CheckedPoint): boolean => a.kind === b.kind && labelOf(a) === labelOf(b) && a.outcome === b.outcome && a.state === b.state;

// Adjacent identical points become one node with a count; the gap to the next node runs from the last of them.
export function buildNodes(points: CheckedPoint[]): LayoutNode[] {
  const runs: Timed[][] = [];
  for (const it of order(points)) {
    const run = runs[runs.length - 1];
    if (run !== undefined && sameNode((run[0] as Timed).p, it.p)) run.push(it);
    else runs.push([it]);
  }
  let day: string | undefined;
  const nodes = runs.map((run): LayoutNode => {
    const first = run[0] as Timed;
    const lastRun = run[run.length - 1] as Timed;
    const p = first.p;
    const cls = classOf(p);
    const start = first.ms === undefined ? undefined : ictParts(first.ms);
    let time = p.time.trim() === '' || p.state === 'not_recorded' ? '—' : '?';
    if (start !== undefined) {
      time = day !== undefined && start.date !== day ? `${start.date} ${start.clock}` : start.clock;
      day = start.date;
    }
    let sub: string | undefined;
    if (run.length > 1) {
      sub = `x${run.length}`;
      if (start !== undefined && lastRun.ms !== undefined) {
        const end = ictParts(lastRun.ms);
        if (end.date !== start.date) sub += ` đến ${end.date} ${end.clock.slice(0, 5)}`;
        else if (end.clock !== start.clock) sub += ` đến ${end.clock}`;
        day = end.date;
      }
    } else if (cls === 'missing') sub = 'không ghi nhận';
    else if (p.state === 'inferred' && start === undefined) sub = 'suy ra';
    return { cls, label: labelOf(p), inferred: p.state === 'inferred', time, marked: start !== undefined && p.source_field.trim() !== '' && p.source_field.trim() !== '_time', ...(sub !== undefined ? { sub } : {}), count: run.length };
  });
  runs.forEach((run, i) => {
    const next = runs[i + 1]?.[0];
    const end = (run[run.length - 1] as Timed).ms;
    const node = nodes[i] as LayoutNode;
    if (next?.ms !== undefined && end !== undefined) node.gap = formatGap(next.ms - end);
  });
  return nodes;
}

function laneOf(title: string, points: CheckedPoint[]): LayoutLane {
  const times = order(points).map((it) => it.ms).filter((ms): ms is number => ms !== undefined);
  const first = times[0];
  const last = times[times.length - 1];
  return { title, sub: first !== undefined && last !== undefined ? dateRange(first, last) : '', nodes: buildNodes(points), points: order(points).map((it) => it.p) };
}

// The requested journey first, the others by their first time; a point with no journey id goes to the requested
// journey, else the first one seen, else a lane of its own.
function journeyLanes(req: IamTraceRequest, server: CheckedPoint[]): LayoutLane[] {
  const asked = [req.journey, req.target].filter((id): id is string => id !== undefined);
  const seen = [...new Set(server.map((p) => p.journey).filter((j) => j !== ''))];
  const fallback = asked.find((id) => seen.includes(id)) ?? seen[0] ?? req.journey ?? '';
  const laneId = (p: CheckedPoint): string => (p.journey === '' ? fallback : p.journey);
  const ids = [...new Set([...server.map(laneId), ...(server.length === 0 ? [fallback] : [])])];
  const firstMs = (id: string): number => order(server.filter((p) => laneId(p) === id)).find((it) => it.ms !== undefined)?.ms ?? Infinity;
  const rank = (id: string): number => (asked.includes(id) ? 0 : 1);
  const sorted = ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || firstMs(a.id) - firstMs(b.id) || a.i - b.i);
  return sorted.map(({ id }) => {
    const campaign = req.journey !== undefined && id === req.journey ? ` / campaign ${idTail(req.target)}` : '';
    return laneOf(id === '' ? UNKNOWN_JOURNEY : `Journey ${idTail(id)}${campaign}`, server.filter((p) => laneId(p) === id));
  });
}

export function layoutTrace(req: IamTraceRequest, trace: MergedTrace): LayoutPlayer[] {
  return mergePlayers(trace.users).map((player) => {
    const journeys = journeyLanes(req, player.points.filter((p) => rowOf(p.kind) === 'server'));
    const client = laneOf(CLIENT_LANE, player.points.filter((p) => rowOf(p.kind) === 'client'));
    return { ...player, journeys, client, points: [...journeys.flatMap((l) => l.points), ...client.points] };
  });
}
