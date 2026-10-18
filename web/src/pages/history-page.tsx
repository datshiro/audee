import { useState } from 'react';
import { Download, ExternalLink, Search, X } from 'lucide-react';
import { api } from '../api/client';
import type { EventRow, EventsPage } from '../api/types';
import { DetailList, downloadCsv, Pager, RecordTable, TagList, type ColumnDef } from '../components/record-table';
import { Spinner } from '../components/ui/controls';
import { Overlay } from '../components/ui/overlay';
import { PageHeader, RefreshButton } from '../components/ui/page';
import { Empty, ErrorState, LoadingBlock } from '../components/ui/states';
import { StatusChip } from '../components/ui/status-chip';
import { dayEndIso, dayStartIso, fmtDateTime, fmtDuration, fmtUsd } from '../lib/format';
import { useDebounced, useLoad } from '../lib/hooks';

const LIMIT = 50;
const who = (e: EventRow): string => e.personName ?? e.principal ?? '—';
const bool = (v: boolean | undefined): string => (v === undefined ? '—' : v ? 'yes' : 'no');

const COLUMNS: ColumnDef<EventRow>[] = [
  { key: 'ts', header: 'Time', render: (e) => <span className="num whitespace-nowrap text-muted">{fmtDateTime(e.ts)}</span>, width: '10.5rem' },
  { key: 'kind', header: 'Kind', render: (e) => <span className="mono text-xs font-medium">{e.kind}</span>, primary: true },
  { key: 'status', header: 'Status', render: (e) => <StatusChip status={e.status} /> },
  { key: 'who', header: 'Person', render: (e) => <span className="truncate">{who(e)}</span> },
  {
    key: 'what',
    header: 'Detail',
    render: (e) => <span className="block truncate text-muted">{e.reason ?? e.intent ?? e.mrUrl?.replace(/^https?:\/\/[^/]+\//, '') ?? ''}</span>,
  },
  { key: 'cost', header: 'Cost', align: 'right', render: (e) => (e.costUsd !== undefined ? fmtUsd(e.costUsd) : <span className="text-subtle">—</span>) },
  { key: 'dur', header: 'Duration', align: 'right', hideOnCard: true, render: (e) => (e.durationMs !== undefined ? fmtDuration(e.durationMs) : <span className="text-subtle">—</span>) },
];

function EventDetail({ e }: { e: EventRow }) {
  return (
    <DetailList
      items={[
        ['Time', <span className="num">{fmtDateTime(e.ts)}</span>],
        ['Kind', <span className="mono">{e.kind}</span>],
        ['Status', <StatusChip status={e.status} />],
        ['Reason', e.reason ?? <span className="text-subtle">—</span>],
        ['Person', e.personName !== undefined ? `${e.personName} (${e.principal ?? ''})` : (e.principal ?? '—')],
        ['Intent', e.intent ?? '—'],
        [
          'MR',
          e.mrUrl !== undefined ? (
            <a className="inline-flex items-center gap-1 break-all text-accent hover:underline" href={e.mrUrl} target="_blank" rel="noreferrer">
              {e.mrUrl} <ExternalLink className="size-3 flex-none" aria-hidden="true" />
            </a>
          ) : (
            '—'
          ),
        ],
        ['MRs in message', e.mrs !== undefined ? String(e.mrs) : '—'],
        ['Message id', <span className="mono text-xs">{e.msgId ?? '—'}</span>],
        ['Session id', <span className="mono text-xs">{e.sessionId ?? '—'}</span>],
        ['Cost', <span className="num">{fmtUsd(e.costUsd)}</span>],
        ['Turns', <span className="num">{e.numTurns ?? '—'}</span>],
        ['Duration', <span className="num">{fmtDuration(e.durationMs)}</span>],
        ['Tool uses', <TagList items={e.toolUses} />],
        ['Denials', <TagList items={e.denials} empty="None" />],
        ['Addressed', bool(e.addressed)],
        ['Allowed', bool(e.allowed)],
        ['Shadow', bool(e.shadow)],
        ['API key', bool(e.token)],
      ]}
    />
  );
}

export function HistoryPage() {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<EventRow | null>(null);
  const query = useDebounced(q.trim());

  const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
  if (kind !== '') params.set('kind', kind);
  if (status !== '') params.set('status', status);
  if (query !== '') params.set('q', query);
  if (from !== '') params.set('from', dayStartIso(from));
  if (to !== '') params.set('to', dayEndIso(to));
  const qs = params.toString();
  const { data, error, loading, reload } = useLoad((signal) => api<EventsPage>(`/api/events?${qs}`, { signal }), [qs]);

  const filtered = kind !== '' || status !== '' || query !== '' || from !== '' || to !== '';
  const update = (f: () => void): void => {
    f();
    setOffset(0);
  };
  const clear = (): void => update(() => {
    setKind('');
    setStatus('');
    setQ('');
    setFrom('');
    setTo('');
  });

  return (
    <>
      <PageHeader
        title="History"
        description="Every event audee recorded, newest first. Times in Asia/Saigon."
        actions={
          <>
            <button type="button" className="btn btn-sm" disabled={!data || data.rows.length === 0} onClick={() => data && downloadCsv(`audee-events-${offset / LIMIT + 1}.csv`, data.rows)}>
              <Download className="size-3.5" aria-hidden="true" /> Export page
            </button>
            <RefreshButton onClick={reload} loading={loading} />
          </>
        }
      />
      <div className="card">
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto] lg:items-end">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <label className="label" htmlFor="ev-q">Search</label>
            <Search className="pointer-events-none absolute bottom-2.5 left-3 size-4 text-subtle" aria-hidden="true" />
            <input id="ev-q" type="search" className="input pl-9" placeholder="Any text in the event" value={q} onChange={(e) => update(() => setQ(e.target.value))} />
            {loading && data !== undefined && <Spinner className="absolute bottom-2.5 right-3 size-4 text-subtle" />}
          </div>
          <div>
            <label className="label" htmlFor="ev-kind">Kind</label>
            <select id="ev-kind" className="input" value={kind} onChange={(e) => update(() => setKind(e.target.value))}>
              <option value="">All kinds</option>
              {data?.kinds.map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ev-status">Status</label>
            <select id="ev-status" className="input" value={status} onChange={(e) => update(() => setStatus(e.target.value))}>
              <option value="">All statuses</option>
              {data?.statuses.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ev-from">From</label>
            <input id="ev-from" type="date" className="input" value={from} max={to || undefined} onChange={(e) => update(() => setFrom(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="ev-to">To</label>
            <input id="ev-to" type="date" className="input" value={to} min={from || undefined} onChange={(e) => update(() => setTo(e.target.value))} />
          </div>
          <button type="button" className="btn btn-ghost justify-self-start" disabled={!filtered} onClick={clear}>
            <X className="size-3.5" aria-hidden="true" /> Clear
          </button>
        </div>
        {data === undefined ? (
          error !== undefined ? <ErrorState message={error} onRetry={reload} /> : <div className="p-4"><LoadingBlock rows={8} /></div>
        ) : (
          <>
            {error !== undefined && <p role="alert" className="border-b border-line bg-danger-soft px-4 py-2 text-xs text-danger">Refresh failed: {error}</p>}
            {data.rows.length === 0 ? (
              <Empty title={filtered ? 'No events match these filters' : 'No events recorded yet'}>
                {filtered && <button type="button" className="btn btn-sm mt-2" onClick={clear}>Clear filters</button>}
              </Empty>
            ) : (
              <div className={loading ? 'opacity-60 transition-opacity' : ''}>
                <RecordTable label="Events" rows={data.rows} columns={COLUMNS} rowKey={(e, i) => `${e.ts}-${e.kind}-${e.status}-${i}`} onOpen={setOpen} />
              </div>
            )}
            <Pager total={data.total} limit={LIMIT} offset={offset} onOffset={setOffset} />
          </>
        )}
      </div>
      <Overlay open={open !== null} onClose={() => setOpen(null)} title={open !== null ? `${open.kind} · ${open.status}` : 'Event'} variant="drawer" description={open !== null ? fmtDateTime(open.ts) : undefined}>
        {open !== null && <EventDetail e={open} />}
      </Overlay>
    </>
  );
}
