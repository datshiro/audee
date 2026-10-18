import { useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import { api } from '../api/client';
import type { DayStat, Overview } from '../api/types';
import { BarList } from '../components/charts/bar-list';
import { ColumnChart, TooltipRow } from '../components/charts/column-chart';
import { LaneBoard } from '../components/lane-board';
import { StatusStrip } from '../components/status-strip';
import { PageHeader, Section } from '../components/ui/page';
import { Empty, ErrorState, Skeleton } from '../components/ui/states';
import { fmtCount, fmtDay, fmtDuration, fmtRuns, fmtUsd, fmtWeekday } from '../lib/format';
import { useLoad } from '../lib/hooks';

export const useOverview = (pollMs?: number) => useLoad((signal) => api<Overview>('/api/overview', { signal }), [], pollMs);

function Tile({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-[1.625rem] font-semibold leading-tight tracking-tight">{value}</div>
      {sub !== undefined && <div className="mt-1 text-xs text-subtle">{sub}</div>}
    </div>
  );
}

function DailyTable({ daily }: { daily: DayStat[] }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Day</th>
            <th className="r">Cost</th>
            <th className="r">Runs</th>
            <th className="r">Failures</th>
            <th className="r">Classified</th>
          </tr>
        </thead>
        <tbody>
          {[...daily].reverse().map((d) => (
            <tr key={d.day}>
              <td>{fmtWeekday(d.day)} {fmtDay(d.day)}</td>
              <td className="r">{fmtUsd(d.costUsd)}</td>
              <td className="r">{d.runs}</td>
              <td className="r">{d.failures}</td>
              <td className="r">{d.classified}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyCharts({ daily }: { daily: DayStat[] }) {
  const [asTable, setAsTable] = useState(false);
  const cost = daily.map((d) => ({
    label: fmtDay(d.day).split(' ')[0] ?? d.day,
    sublabel: `${fmtWeekday(d.day)} ${fmtDay(d.day)}`,
    segments: [{ value: d.costUsd, color: 'var(--series-1)' }],
    tooltip: <TooltipRow label="Cost" value={fmtUsd(d.costUsd)} />,
  }));
  const runs = daily.map((d) => {
    const failed = Math.min(d.failures, d.runs);
    return {
      label: fmtDay(d.day).split(' ')[0] ?? d.day,
      sublabel: `${fmtWeekday(d.day)} ${fmtDay(d.day)}`,
      segments: [
        { value: d.runs - failed, color: 'var(--series-1)' },
        { value: failed, color: 'var(--series-fail)' },
        { value: d.classified, color: 'var(--series-2)' },
      ],
      tooltip: (
        <>
          <TooltipRow color="var(--series-1)" label="Runs" value={String(d.runs)} />
          <TooltipRow color="var(--series-fail)" label="Failures" value={String(d.failures)} />
          <TooltipRow color="var(--series-2)" label="Classified" value={String(d.classified)} />
        </>
      ),
    };
  });
  const total = daily.reduce((n, d) => n + d.costUsd, 0);
  const totalRuns = daily.reduce((n, d) => n + d.runs, 0);
  const totalFail = daily.reduce((n, d) => n + d.failures, 0);
  const totalClassified = daily.reduce((n, d) => n + d.classified, 0);
  return (
    <Section
      title="Last 14 days"
      description="Local dates, oldest on the left"
      actions={
        <button type="button" className="btn btn-sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? <BarChart3 className="size-3.5" aria-hidden="true" /> : <Table2 className="size-3.5" aria-hidden="true" />}
          {asTable ? 'Chart' : 'Table'}
        </button>
      }
    >
      {asTable ? (
        <DailyTable daily={daily} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <figure className="min-w-0">
            <figcaption className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-[0.8125rem] font-medium">Cost per day</span>
              <span className="num text-xs text-muted">{fmtUsd(total)} total</span>
            </figcaption>
            <ColumnChart columns={cost} label={`Cost per day, last 14 days, ${fmtUsd(total)} total`} formatTick={(n) => (n === 0 ? '$0' : `$${n % 1 === 0 ? n : n.toFixed(1)}`)} />
          </figure>
          <figure className="min-w-0">
            <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[0.8125rem] font-medium">Activity per day</span>
              <span className="flex items-center gap-3 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-sm bg-[var(--series-1)]" aria-hidden="true" />
                  Runs <span className="num">{totalRuns}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-sm bg-[var(--series-fail)]" aria-hidden="true" />
                  Failed <span className="num">{totalFail}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-sm bg-[var(--series-2)]" aria-hidden="true" />
                  Classified <span className="num">{totalClassified}</span>
                </span>
              </span>
            </figcaption>
            <ColumnChart columns={runs} label={`Activity per day, last 14 days, ${totalRuns} runs, ${totalFail} failures and ${totalClassified} classified messages`} formatTick={(n) => fmtCount(n)} />
          </figure>
        </div>
      )}
    </Section>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading overview">
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}

export function OverviewPage() {
  const { data: o, error, reload } = useOverview(3000);

  return (
    <>
      <PageHeader title="Overview" description="What audee is doing right now and what it has cost. Refreshes every 3 seconds." />
      {o === undefined ? (
        error !== undefined ? <div className="card"><ErrorState message={error} onRetry={reload} /></div> : <OverviewSkeleton />
      ) : (
        <div className="space-y-6">
          {error !== undefined && (
            <p role="status" className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
              Live refresh failed ({error}). Showing the last data received.
            </p>
          )}
          <StatusStrip o={o} />

          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Tile label="Cost, last 24h" value={fmtUsd(o.totals.cost24h)} sub={<span className="num">7d {fmtUsd(o.totals.cost7d)} · all {fmtUsd(o.totals.costAll)}</span>} />
            <Tile
              label="Runs, last 24h"
              value={fmtCount(o.totals.runs24h)}
              sub={
                o.totals.failures24h > 0 ? (
                  <span className="font-medium text-danger">{o.totals.failures24h} failed</span>
                ) : (
                  'No failures'
                )
              }
            />
            <Tile label="Classified, last 24h" value={fmtCount(o.totals.classified24h)} sub="Messages the classifier handled" />
            <Tile label="Avg run time, 24h" value={o.totals.avgDurationMs24h > 0 ? fmtDuration(o.totals.avgDurationMs24h) : '—'} sub={`Max ${o.maxConcurrent} sessions at once`} />
          </div>

          <DailyCharts daily={o.daily} />

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="By capability" description="Last 7 days, by cost">
              {o.byKind.length === 0 ? (
                <Empty title="No runs in the last 7 days" />
              ) : (
                <BarList
                  caption="Cost by capability, last 7 days"
                  rows={[...o.byKind]
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((k) => ({
                      key: k.kind,
                      label: k.kind,
                      value: k.costUsd,
                      display: fmtUsd(k.costUsd),
                      detail: `${fmtRuns(k.runs)}${k.failures > 0 ? ` · ${k.failures} failed` : ''} · avg ${fmtDuration(k.avgDurationMs)}`,
                    }))}
                />
              )}
            </Section>
            <Section title="By person" description="Last 7 days, by cost">
              {o.byPerson.length === 0 ? (
                <Empty title="No requests in the last 7 days" />
              ) : (
                <BarList
                  caption="Cost by person, last 7 days"
                  rows={[...o.byPerson]
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((p) => ({ key: p.principal, label: p.personName ?? p.principal, value: p.costUsd, display: fmtUsd(p.costUsd), detail: fmtRuns(p.runs) }))}
                />
              )}
            </Section>
          </div>

          <div>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-[0.9375rem] font-semibold">Lanes</h2>
              <a href="#/jobs" className="inline-flex items-center text-[0.8125rem] text-accent hover:underline pointer-coarse:min-h-11">
                Manage jobs
              </a>
            </div>
            {o.lanes.length === 0 ? <div className="card"><Empty title="No lanes configured" /></div> : <LaneBoard lanes={o.lanes} onChanged={reload} showQueued={false} />}
          </div>
        </div>
      )}
    </>
  );
}
