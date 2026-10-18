const TZ = 'Asia/Saigon';

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeShort = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });

const valid = (iso: string | undefined): Date | undefined => {
  if (iso === undefined) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export const fmtDateTime = (iso?: string): string => {
  const d = valid(iso);
  return d === undefined ? '—' : dateTime.format(d);
};

export const fmtDateTimeShort = (iso?: string): string => {
  const d = valid(iso);
  return d === undefined ? '—' : dateTimeShort.format(d);
};

export const fmtDay = (day: string): string => dayLabel.format(new Date(`${day}T00:00:00Z`));
export const fmtWeekday = (day: string): string => weekday.format(new Date(`${day}T00:00:00Z`));

export function fmtUsd(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return '<$0.01';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtAgo(iso: string | undefined, now: number): string {
  const d = valid(iso);
  if (d === undefined) return 'never';
  const ms = now - d.getTime();
  if (ms < 45_000) return 'just now';
  return `${fmtDuration(ms).split(' ')[0]} ago`;
}

export const fmtCount = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString('en'));
export const fmtRuns = (n: number): string => `${fmtCount(n)} ${n === 1 ? 'run' : 'runs'}`;

export function msToDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

export const DURATION_RE = /^(\d+)(s|m|h)$/;

export function dayStartIso(date: string): string {
  return new Date(`${date}T00:00:00+07:00`).toISOString();
}

export function dayEndIso(date: string): string {
  return new Date(`${date}T23:59:59.999+07:00`).toISOString();
}
