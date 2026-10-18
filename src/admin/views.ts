// Read-only views over what the daemon keeps: events.jsonl, the message trail and the recorded requests.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolvePerson } from '../authz/people.js';
import type { Config } from '../config/schema.js';
import { eventsPath } from '../events.js';
import { type Job, jobKey } from '../queue/job.js';
import type { LaneSnapshot } from '../queue/queue.js';
import type { State } from '../state/state.js';
import type { DayStat, EventRow, EventsPage, JobView, KindStat, LaneView, MessagesPage, Overview, PersonStat, RequestsPage } from './api-types.js';

const EVENT_KEYS: Record<string, keyof EventRow> = {
  ts: 'ts', kind: 'kind', status: 'status', reason: 'reason', msg_id: 'msgId', mr: 'mrUrl', principal: 'principal', intent: 'intent',
  addressed: 'addressed', mrs: 'mrs', session_id: 'sessionId', cost_usd: 'costUsd', num_turns: 'numTurns', duration_ms: 'durationMs',
  shadow: 'shadow', allowed: 'allowed', tool_uses: 'toolUses', denials: 'denials', token: 'token',
};

const personName = (cfg: Config, principal: string | undefined): string | undefined =>
  principal === undefined ? undefined : resolvePerson(cfg, principal)?.name;

let cached: { path: string; size: number; mtimeMs: number; cfg: Config; rows: EventRow[] } | undefined;

// Every event, oldest first, parsed again only when the file or the config changed (the dashboard polls).
// A malformed line (a crash mid-append) is skipped, not fatal.
export function readEvents(dataDir: string, cfg: Config): EventRow[] {
  const path = eventsPath(dataDir);
  if (!existsSync(path)) return [];
  const { size, mtimeMs } = statSync(path);
  if (cached?.path === path && cached.size === size && cached.mtimeMs === mtimeMs && cached.cfg === cfg) return cached.rows;
  const rows: EventRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const row: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(EVENT_KEYS)) if (raw[key] !== undefined) row[field] = raw[key];
    if (typeof row['ts'] !== 'string' || typeof row['kind'] !== 'string' || typeof row['status'] !== 'string') continue;
    const name = personName(cfg, row['principal'] as string | undefined);
    if (name !== undefined) row['personName'] = name;
    rows.push(row as EventRow);
  }
  cached = { path, size, mtimeMs, cfg, rows };
  return rows;
}

export function jobView(cfg: Config, job: Job, startedAt?: Date): JobView {
  const name = personName(cfg, job.principal);
  return {
    kind: job.kind, key: jobKey(job), chatId: job.chatId, principal: job.principal, requesterName: job.requesterName, requestedAt: job.requestedAt,
    ...(name !== undefined ? { personName: name } : {}),
    ...(job.mrUrl !== undefined ? { mrUrl: job.mrUrl } : {}),
    ...(job.messageId !== undefined ? { messageId: job.messageId } : {}),
    ...(job.input !== undefined ? { input: job.input } : {}),
    ...(startedAt !== undefined ? { startedAt: startedAt.toISOString() } : {}),
  };
}

const localDay = (d: Date): string => d.toLocaleDateString('en-CA');
const isRun = (e: EventRow): boolean => e.kind !== 'classify' && e.status !== 'started';
const sum = (rows: EventRow[], f: (e: EventRow) => number): number => rows.reduce((n, e) => n + f(e), 0);

export type OverviewInput = {
  cfg: Config; state: State; lanes: LaneSnapshot[]; events: EventRow[]; configPath: string; dataDir: string;
  startedAt: Date; reloadedAt: Date; reloadError?: string; now: Date;
};

export function overview(o: OverviewInput): Overview {
  const now = o.now.getTime();
  const since = (ms: number): EventRow[] => o.events.filter((e) => now - Date.parse(e.ts) < ms);
  const day = since(24 * 3600_000);
  const week = since(7 * 24 * 3600_000);
  const timed = day.filter((e) => isRun(e) && e.durationMs !== undefined);

  const daily: DayStat[] = [];
  const byDay = new Map<string, DayStat>();
  for (let i = 13; i >= 0; i--) {
    const d = localDay(new Date(now - i * 24 * 3600_000));
    const stat = { day: d, costUsd: 0, runs: 0, failures: 0, classified: 0 };
    daily.push(stat);
    byDay.set(d, stat);
  }
  for (const e of o.events) {
    const stat = byDay.get(localDay(new Date(e.ts)));
    if (stat === undefined) continue;
    stat.costUsd += e.costUsd ?? 0;
    if (isRun(e)) stat.runs++;
    if (e.status === 'failed') stat.failures++;
    if (e.kind === 'classify' && e.status === 'classified') stat.classified++;
  }

  const kinds = new Map<string, KindStat & { timed: number }>();
  const people = new Map<string, PersonStat>();
  for (const e of week) {
    if (e.status === 'started') continue;
    const k = kinds.get(e.kind) ?? { kind: e.kind, runs: 0, failures: 0, costUsd: 0, avgDurationMs: 0, timed: 0 };
    k.runs++;
    if (e.status === 'failed') k.failures++;
    k.costUsd += e.costUsd ?? 0;
    if (e.durationMs !== undefined) {
      k.avgDurationMs = (k.avgDurationMs * k.timed + e.durationMs) / (k.timed + 1);
      k.timed++;
    }
    kinds.set(e.kind, k);
    if (e.principal !== undefined) {
      const p = people.get(e.principal) ?? { principal: e.principal, ...(e.personName !== undefined ? { personName: e.personName } : {}), runs: 0, costUsd: 0 };
      p.runs++;
      p.costUsd += e.costUsd ?? 0;
      people.set(e.principal, p);
    }
  }

  const lanes: LaneView[] = o.lanes.map((l) => ({
    name: l.name, concurrency: l.concurrency, buffer: l.buffer,
    running: l.running.map((r) => jobView(o.cfg, r.job, r.startedAt)),
    queued: l.queued.map((j) => jobView(o.cfg, j)),
  }));
  const lastInbox = o.state.lastInbox();
  return {
    pid: process.pid,
    startedAt: o.startedAt.toISOString(),
    reloadedAt: o.reloadedAt.toISOString(),
    ...(o.reloadError !== undefined ? { reloadError: o.reloadError } : {}),
    mode: o.cfg.channels.teams.shadow ? 'shadow' : 'live',
    paused: o.state.paused,
    maxConcurrent: o.cfg.concurrency.max_concurrent,
    lanes,
    ...(lastInbox !== undefined ? { lastInboxAt: lastInbox.toISOString() } : {}),
    configPath: o.configPath,
    dataDir: o.dataDir,
    totals: {
      cost24h: sum(day, (e) => e.costUsd ?? 0),
      cost7d: sum(week, (e) => e.costUsd ?? 0),
      costAll: sum(o.events, (e) => e.costUsd ?? 0),
      runs24h: day.filter(isRun).length,
      failures24h: day.filter((e) => e.status === 'failed').length,
      classified24h: day.filter((e) => e.kind === 'classify' && e.status === 'classified').length,
      avgDurationMs24h: timed.length === 0 ? 0 : sum(timed, (e) => e.durationMs ?? 0) / timed.length,
    },
    daily,
    byKind: [...kinds.values()].map(({ timed: _timed, ...k }) => k).sort((a, b) => b.runs - a.runs),
    byPerson: [...people.values()].sort((a, b) => b.runs - a.runs),
  };
}

export type PageQuery = { limit: number; offset: number };

export function pageQuery(params: URLSearchParams): PageQuery {
  const num = (name: string, fallback: number, max: number): number => {
    const n = Number(params.get(name) ?? fallback);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
  };
  return { limit: num('limit', 50, 500) || 50, offset: num('offset', 0, Number.MAX_SAFE_INTEGER) };
}

const matches = (row: unknown, q: string): boolean => q === '' || JSON.stringify(row).toLowerCase().includes(q.toLowerCase());
const distinct = (values: string[]): string[] => [...new Set(values)].sort();

export function eventsPage(events: EventRow[], params: URLSearchParams): EventsPage {
  const kind = params.get('kind') ?? '';
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const from = Date.parse(params.get('from') ?? '');
  const to = Date.parse(params.get('to') ?? '');
  const rows = events.filter((e) => {
    const t = Date.parse(e.ts);
    return (kind === '' || e.kind === kind) && (status === '' || e.status === status)
      && (Number.isNaN(from) || t >= from) && (Number.isNaN(to) || t <= to) && matches(e, q);
  }).reverse();
  const { limit, offset } = pageQuery(params);
  return { total: rows.length, rows: rows.slice(offset, offset + limit), kinds: distinct(events.map((e) => e.kind)), statuses: distinct(events.map((e) => e.status)) };
}

export function messagesPage(cfg: Config, state: State, params: URLSearchParams): MessagesPage {
  const outcome = params.get('outcome') ?? '';
  const q = params.get('q') ?? '';
  const rows = state.messages.map((m) => {
    const name = m.senderId === undefined ? undefined : personName(cfg, `teams:${m.senderId}`);
    return { ...m, ...(name !== undefined ? { personName: name } : {}) };
  }).filter((m) => (outcome === '' || m.outcome === outcome) && matches(m, q)).reverse();
  const { limit, offset } = pageQuery(params);
  return { total: rows.length, rows: rows.slice(offset, offset + limit), outcomes: distinct(state.messages.map((m) => m.outcome)) };
}

export function requestsPage(cfg: Config, state: State, params: URLSearchParams): RequestsPage {
  const q = params.get('q') ?? '';
  const pending = state.pendingJobs();
  const rows = Object.values(state.requests)
    .map((j) => ({ ...jobView(cfg, j), inflight: pending.some((p) => p.kind === j.kind && jobKey(p) === jobKey(j)) }))
    .filter((r) => matches(r, q))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return { rows: rows.slice(0, 200) };
}
