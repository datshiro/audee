import { useState } from 'react';
import { CirclePause, CirclePlay, RotateCcw, Search } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import type { PauseResult, RequestsPage, RetryResult } from '../api/types';
import { JobSummary, LaneBoard, jobWho } from '../components/lane-board';
import { Spinner } from '../components/ui/controls';
import { Confirm } from '../components/ui/overlay';
import { PageHeader, RefreshButton, Section } from '../components/ui/page';
import { Empty, ErrorState, LoadingBlock } from '../components/ui/states';
import { useToast } from '../components/ui/toast';
import { fmtDateTimeShort } from '../lib/format';
import { useDebounced, useLoad } from '../lib/hooks';
import { useOverview } from './overview-page';

const RETRY_MESSAGES: Record<RetryResult['result'], { tone: 'ok' | 'warn'; title: string; detail: string }> = {
  queued: { tone: 'ok', title: 'Queued again', detail: 'The request is back in its lane.' },
  duplicate: { tone: 'warn', title: 'Already queued or running', detail: 'The same request is in flight, so nothing was added.' },
  limit: { tone: 'warn', title: 'Person is at their limit', detail: 'They have as many jobs in flight as max_inflight or per_person_limit allows.' },
  cooldown: { tone: 'warn', title: 'Cooling down', detail: 'This request ran very recently. Try again in a moment.' },
  busy: { tone: 'warn', title: 'Lane is full', detail: 'The lane buffer is full. Try again when the queue drains.' },
};

function PauseControl({ paused, onChanged }: { paused: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      const r = await api<PauseResult>('/api/queue/pause', { method: 'POST', body: { paused: next } });
      toast('ok', r.paused ? 'Queue paused' : 'Queue resumed', r.paused ? 'Running jobs finish; new jobs wait.' : 'Queued jobs start as slots free up.');
      setConfirm(false);
      onChanged();
    } catch (e) {
      toast('danger', 'Could not change the queue', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={`btn ${paused ? 'btn-primary' : ''}`} disabled={busy} onClick={() => (paused ? void set(false) : setConfirm(true))}>
        {busy ? <Spinner /> : paused ? <CirclePlay className="size-4" aria-hidden="true" /> : <CirclePause className="size-4" aria-hidden="true" />}
        {paused ? 'Resume queue' : 'Pause queue'}
      </button>
      <Confirm open={confirm} title="Pause the queue?" confirmLabel="Pause queue" busy={busy} onConfirm={() => void set(true)} onClose={() => setConfirm(false)}>
        Jobs already running keep going. New and queued jobs wait until you resume. Messages are still read and classified.
      </Confirm>
    </>
  );
}

function RetryList() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim());
  const [confirmKey, setConfirmKey] = useState<{ kind: string; key: string; who: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad((signal) => api<RequestsPage>(`/api/requests?q=${encodeURIComponent(query)}`, { signal }), [query]);

  const retry = async (): Promise<void> => {
    if (confirmKey === null) return;
    setBusy(true);
    try {
      const { result } = await api<RetryResult>('/api/jobs/retry', { method: 'POST', body: { kind: confirmKey.kind, key: confirmKey.key } });
      const m = RETRY_MESSAGES[result] ?? { tone: 'warn' as const, title: result, detail: '' };
      toast(m.tone, m.title, m.detail);
      setConfirmKey(null);
      reload();
    } catch (e) {
      toast('danger', 'Retry failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Retry a past request"
      description="Requests audee has recorded, newest first (up to 200)."
      actions={<RefreshButton onClick={reload} loading={loading} />}
    >
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
        <label htmlFor="req-search" className="sr-only">
          Search requests
        </label>
        <input id="req-search" type="search" className="input pl-9" placeholder="Search by person, kind, MR, text…" value={q} onChange={(e) => setQ(e.target.value)} />
        {loading && data !== undefined && <Spinner className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />}
      </div>
      {data === undefined ? (
        error !== undefined ? <ErrorState compact message={error} onRetry={reload} /> : <LoadingBlock />
      ) : data.rows.length === 0 ? (
        <Empty title={query === '' ? 'No recorded requests yet' : `No requests match “${query}”`}>
          {query !== '' && (
            <button type="button" className="btn btn-sm mt-2" onClick={() => setQ('')}>
              Clear search
            </button>
          )}
        </Empty>
      ) : (
        <ul className="-mx-1 divide-y divide-[var(--border)]">
          {data.rows.map((r) => (
            <li key={`${r.kind}:${r.key}`} className="flex items-center gap-3 px-1 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="mono text-xs font-semibold">{r.kind}</span>
                  <span className="text-xs text-muted">{jobWho(r)}</span>
                  <span className="num text-xs text-subtle">{fmtDateTimeShort(r.requestedAt)}</span>
                  {r.inflight && <span className="chip chip-info">in flight</span>}
                </div>
                <div className="min-w-0 text-[0.8125rem]">
                  <JobSummary job={r} />
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm flex-none"
                disabled={r.inflight}
                title={r.inflight ? 'Already queued or running' : undefined}
                aria-label={`Retry ${r.kind} for ${jobWho(r)}`}
                onClick={() => setConfirmKey({ kind: r.kind, key: r.key, who: jobWho(r) })}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Retry</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Confirm open={confirmKey !== null} title="Run this request again?" confirmLabel="Retry" busy={busy} onConfirm={() => void retry()} onClose={() => setConfirmKey(null)}>
        {confirmKey !== null && (
          <>
            <span className="mono text-ink">{confirmKey.kind}</span> for <span className="text-ink">{confirmKey.who}</span> goes back into its lane and costs another run.
          </>
        )}
      </Confirm>
    </Section>
  );
}

export function JobsPage() {
  const { data: o, error, reload } = useOverview(3000);
  return (
    <>
      <PageHeader
        title="Jobs"
        description="Running and queued work per lane. Refreshes every 3 seconds."
        actions={o !== undefined && <PauseControl paused={o.paused} onChanged={reload} />}
      />
      <div className="space-y-6">
        {o?.mode === 'shadow' && (
          <p className="shadow-band rounded-lg px-4 py-3 text-[0.8125rem] font-medium">Shadow mode is on: audee classifies messages but never runs jobs.</p>
        )}
        {o?.paused && (
          <p className="rounded-lg border border-[var(--warn-strong)] bg-warn-soft px-4 py-3 text-[0.8125rem] text-ink">
            The queue is paused. Running jobs finish; queued jobs wait until you resume.
          </p>
        )}
        {o === undefined ? (
          error !== undefined ? <div className="card"><ErrorState message={error} onRetry={reload} /></div> : <LoadingBlock rows={3} />
        ) : o.lanes.length === 0 ? (
          <div className="card"><Empty title="No lanes configured">Add a lane under Settings → Concurrency.</Empty></div>
        ) : (
          <LaneBoard lanes={o.lanes} onChanged={reload} />
        )}
        <RetryList />
      </div>
    </>
  );
}
