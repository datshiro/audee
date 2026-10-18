import { CirclePause, Radio, TriangleAlert, Eye } from 'lucide-react';
import type { Overview } from '../api/types';
import { fmtAgo, fmtDateTime, fmtDuration } from '../lib/format';
import { useNow } from '../lib/hooks';

function Meta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="num mt-0.5 truncate text-[0.8125rem] font-medium" title={title}>
        {value}
      </dd>
    </div>
  );
}

export function StatusStrip({ o }: { o: Overview }) {
  const now = useNow(5000);
  const shadow = o.mode === 'shadow';
  return (
    <div className="space-y-3">
      {o.reloadError !== undefined && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-[0.8125rem]">
          <TriangleAlert className="mt-0.5 size-4 flex-none text-danger" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-semibold text-danger">The last config reload failed. The previous config is still running.</div>
            <div className="mono mt-1 break-words text-xs">{o.reloadError}</div>
          </div>
        </div>
      )}
      <div className={`overflow-hidden rounded-lg ${shadow ? 'shadow-band' : 'card'}`}>
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex items-center gap-3.5">
            <span className={`grid size-11 flex-none place-items-center rounded-lg ${shadow ? 'bg-[var(--warn-strong)] text-[oklch(20%_0.02_80)]' : 'bg-ok-soft text-ok'}`}>
              {shadow ? <Eye className="size-5" aria-hidden="true" /> : <Radio className="size-5" aria-hidden="true" />}
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-lg font-bold tracking-wide">{shadow ? 'SHADOW MODE' : 'LIVE'}</span>
                {!shadow && <span className="pulse size-2 rounded-full bg-[var(--ok)]" aria-hidden="true" />}
                {o.paused && (
                  <span className="chip chip-warn chip-plain gap-1">
                    <CirclePause className="size-3" aria-hidden="true" /> Queue paused
                  </span>
                )}
              </div>
              <p className={`text-[0.8125rem] ${shadow ? 'font-medium text-ink' : 'text-muted'}`}>
                {shadow
                  ? 'Classifies messages only. Shadow mode never runs jobs and never replies.'
                  : o.paused
                    ? 'Watching chats. New jobs wait in the queue until you resume it.'
                    : 'Watching chats and running jobs for allowed people.'}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-2 sm:flex sm:gap-8">
            <Meta label="PID" value={String(o.pid)} />
            <Meta label="Uptime" value={fmtDuration(now - Date.parse(o.startedAt))} title={`Started ${fmtDateTime(o.startedAt)} · reloaded ${fmtDateTime(o.reloadedAt)}`} />
            <Meta label="Last inbox" value={fmtAgo(o.lastInboxAt, now)} title={fmtDateTime(o.lastInboxAt)} />
          </dl>
        </div>
      </div>
    </div>
  );
}
