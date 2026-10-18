import { useState } from 'react';
import { ExternalLink, Square, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import type { CancelResult, JobView, LaneView } from '../api/types';
import { fmtAgo, fmtDuration, fmtDateTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Confirm } from './ui/overlay';
import { useToast } from './ui/toast';

type Pending = { job: JobView; running: boolean };

export function jobWho(job: JobView): string {
  return job.personName ?? job.requesterName;
}

export function JobSummary({ job }: { job: JobView }) {
  if (job.mrUrl !== undefined) {
    return (
      <a href={job.mrUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-accent hover:underline pointer-coarse:min-h-6">
        <span className="truncate mono text-xs">{job.mrUrl.replace(/^https?:\/\/[^/]+\//, '')}</span>
        <ExternalLink className="size-3 flex-none" aria-hidden="true" />
      </a>
    );
  }
  return <span className="block truncate text-muted" title={job.input}>{job.input ?? job.key}</span>;
}

function JobLine({ job, running, now, onAct }: { job: JobView; running: boolean; now: number; onAct: (p: Pending) => void }) {
  const elapsed = running && job.startedAt !== undefined ? now - Date.parse(job.startedAt) : undefined;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className={`size-2 flex-none rounded-full ${running ? 'pulse bg-[var(--info)]' : 'bg-[var(--border-strong)]'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="mono text-xs font-semibold">{job.kind}</span>
          <span className="text-xs text-muted">{jobWho(job)}</span>
        </div>
        <div className="min-w-0 text-[0.8125rem]">
          <JobSummary job={job} />
        </div>
      </div>
      <div className="flex-none text-right">
        {running ? (
          <div className="num text-[0.8125rem] font-medium" title={`Started ${fmtDateTime(job.startedAt)}`}>
            {fmtDuration(elapsed)}
          </div>
        ) : (
          <div className="text-xs text-subtle" title={`Requested ${fmtDateTime(job.requestedAt)}`}>
            waiting {fmtAgo(job.requestedAt, now).replace(' ago', '')}
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-sm flex-none"
        onClick={() => onAct({ job, running })}
        aria-label={`${running ? 'Stop' : 'Remove'} ${job.kind} job for ${jobWho(job)}`}
      >
        {running ? <Square className="size-3" aria-hidden="true" /> : <Trash2 className="size-3.5" aria-hidden="true" />}
        <span className="hidden sm:inline">{running ? 'Stop' : 'Remove'}</span>
      </button>
    </li>
  );
}

export function LaneBoard({ lanes, onChanged, showQueued = true }: { lanes: LaneView[]; onChanged: () => void; showQueued?: boolean }) {
  const now = useNow();
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (): Promise<void> => {
    if (pending === null) return;
    setBusy(true);
    try {
      const { result } = await api<CancelResult>('/api/jobs/cancel', { method: 'POST', body: { kind: pending.job.kind, key: pending.job.key } });
      if (result === 'not_found') toast('warn', 'Job already finished', 'It was no longer running or queued.');
      else toast('ok', result === 'cancelled' ? 'Job stopped' : 'Job removed from the queue', `${pending.job.kind} · ${jobWho(pending.job)}`);
      setPending(null);
      onChanged();
    } catch (e) {
      toast('danger', 'Could not cancel the job', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        {lanes.map((lane) => {
          const used = lane.running.length;
          return (
            <section key={lane.name} className="card min-w-0" aria-label={`Lane ${lane.name}`}>
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <h3 className="mono text-[0.8125rem] font-semibold">{lane.name}</h3>
                  <span className="text-xs text-subtle">lane</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted">
                  <span className="flex items-center gap-1.5" aria-label={`${used} of ${lane.concurrency} slots in use`}>
                    {Array.from({ length: lane.concurrency }, (_, i) => (
                      <span key={i} className={`h-2 w-3 rounded-[2px] ${i < used ? 'bg-[var(--info)]' : 'bg-sunken ring-1 ring-inset ring-[var(--border-strong)]'}`} />
                    ))}
                    <span className="num ml-1">
                      {used}/{lane.concurrency} running
                    </span>
                  </span>
                  <span className="num">
                    {lane.queued.length}/{lane.buffer} queued
                  </span>
                </div>
              </header>
              <div className="px-4">
                {lane.running.length === 0 && (!showQueued || lane.queued.length === 0) ? (
                  <p className="py-4 text-[0.8125rem] text-subtle">Idle. Nothing running{showQueued ? ' or queued' : ''}.</p>
                ) : (
                  <>
                    <ul className="divide-y divide-[var(--border)]">
                      {lane.running.map((j) => (
                        <JobLine key={`${j.kind}:${j.key}`} job={j} running now={now} onAct={setPending} />
                      ))}
                    </ul>
                    {showQueued && lane.queued.length > 0 && (
                      <>
                        <div className="eyebrow border-t border-line pb-1 pt-3">Queued · {lane.queued.length}</div>
                        <ol className="divide-y divide-[var(--border)]">
                          {lane.queued.map((j) => (
                            <JobLine key={`${j.kind}:${j.key}`} job={j} running={false} now={now} onAct={setPending} />
                          ))}
                        </ol>
                      </>
                    )}
                    {!showQueued && lane.queued.length > 0 && <p className="border-t border-line py-2.5 text-xs text-subtle">+ {lane.queued.length} queued</p>}
                  </>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <Confirm
        open={pending !== null}
        title={pending?.running ? 'Stop this running job?' : 'Remove this queued job?'}
        confirmLabel={pending?.running ? 'Stop job' : 'Remove job'}
        danger
        busy={busy}
        onConfirm={() => void act()}
        onClose={() => setPending(null)}
      >
        {pending !== null && (
          <>
            <p>
              <span className="mono font-medium text-ink">{pending.job.kind}</span> for <span className="font-medium text-ink">{jobWho(pending.job)}</span>
              {pending.running ? ' will be interrupted now. Anything it has not posted yet is lost.' : ' will be dropped from the queue and never run.'}
            </p>
            <p className="mt-2 truncate mono text-xs">{pending.job.mrUrl ?? pending.job.input ?? pending.job.key}</p>
          </>
        )}
      </Confirm>
    </>
  );
}
