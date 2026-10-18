import { useState } from 'react';
import { Download, ExternalLink, Search, X } from 'lucide-react';
import { api } from '../api/client';
import type { MessageRow, MessagesPage as Page } from '../api/types';
import { DetailList, downloadCsv, Pager, RecordTable, type ColumnDef } from '../components/record-table';
import { Spinner } from '../components/ui/controls';
import { Overlay } from '../components/ui/overlay';
import { PageHeader, RefreshButton } from '../components/ui/page';
import { Empty, ErrorState, LoadingBlock } from '../components/ui/states';
import { StatusChip } from '../components/ui/status-chip';
import { fmtDateTime } from '../lib/format';
import { useDebounced, useLoad } from '../lib/hooks';

const LIMIT = 50;
const sender = (m: MessageRow): string => m.personName ?? m.senderId ?? '—';

const COLUMNS: ColumnDef<MessageRow>[] = [
  { key: 'at', header: 'Received', render: (m) => <span className="num whitespace-nowrap text-muted">{fmtDateTime(m.sentAt ?? m.claimedAt)}</span>, width: '10.5rem' },
  { key: 'from', header: 'From', render: (m) => <span className="truncate">{sender(m)}</span>, primary: true },
  { key: 'outcome', header: 'Outcome', render: (m) => <StatusChip status={m.outcome} /> },
  { key: 'intent', header: 'Intent', render: (m) => <span className="mono text-xs">{m.intent ?? '—'}</span> },
  { key: 'reason', header: 'Reason', render: (m) => <span className="block truncate text-muted">{m.lastError ?? m.reason ?? ''}</span> },
  { key: 'attempts', header: 'Tries', align: 'right', hideOnCard: true, render: (m) => m.attempts },
];

function MessageDetail({ m }: { m: MessageRow }) {
  return (
    <DetailList
      items={[
        ['Outcome', <StatusChip status={m.outcome} />],
        ['Reason', m.reason ?? '—'],
        ['Last error', m.lastError !== undefined ? <span className="mono text-xs text-danger">{m.lastError}</span> : '—'],
        ['From', m.personName !== undefined ? `${m.personName} (${m.senderId ?? ''})` : (m.senderId ?? '—')],
        ['Intent', m.intent ?? '—'],
        ['Addressed', m.addressed === undefined ? '—' : m.addressed ? 'yes' : 'no'],
        [
          'MRs',
          m.mrUrls !== undefined && m.mrUrls.length > 0 ? (
            <ul className="space-y-1">
              {m.mrUrls.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">
                    {u} <ExternalLink className="size-3 flex-none" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            '—'
          ),
        ],
        ['Sent', <span className="num">{fmtDateTime(m.sentAt)}</span>],
        ['Claimed', <span className="num">{fmtDateTime(m.claimedAt)}</span>],
        ['Updated', <span className="num">{fmtDateTime(m.updatedAt)}</span>],
        ['Attempts', <span className="num">{m.attempts}</span>],
        ['Message id', <span className="mono text-xs">{m.id ?? '—'}</span>],
        ['Chat id', <span className="mono text-xs">{m.chatId ?? '—'}</span>],
        ['File', <span className="mono text-xs">{m.file}</span>],
      ]}
    />
  );
}

export function MessagesPage() {
  const [outcome, setOutcome] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<MessageRow | null>(null);
  const query = useDebounced(q.trim());

  const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
  if (outcome !== '') params.set('outcome', outcome);
  if (query !== '') params.set('q', query);
  const qs = params.toString();
  const { data, error, loading, reload } = useLoad((signal) => api<Page>(`/api/messages?${qs}`, { signal }), [qs]);
  const filtered = outcome !== '' || query !== '';
  const clear = (): void => {
    setOutcome('');
    setQ('');
    setOffset(0);
  };

  return (
    <>
      <PageHeader
        title="Messages"
        description="The inbox trail: every Teams message audee picked up and what it did with it."
        actions={
          <>
            <button type="button" className="btn btn-sm" disabled={!data || data.rows.length === 0} onClick={() => data && downloadCsv(`audee-messages-${offset / LIMIT + 1}.csv`, data.rows)}>
              <Download className="size-3.5" aria-hidden="true" /> Export page
            </button>
            <RefreshButton onClick={reload} loading={loading} />
          </>
        }
      />
      <div className="card">
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
          <div className="relative">
            <label className="label" htmlFor="msg-q">Search</label>
            <Search className="pointer-events-none absolute bottom-2.5 left-3 size-4 text-subtle" aria-hidden="true" />
            <input id="msg-q" type="search" className="input pl-9" placeholder="Sender, intent, MR, error…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
            {loading && data !== undefined && <Spinner className="absolute bottom-2.5 right-3 size-4 text-subtle" />}
          </div>
          <div>
            <label className="label" htmlFor="msg-outcome">Outcome</label>
            <select id="msg-outcome" className="input" value={outcome} onChange={(e) => { setOutcome(e.target.value); setOffset(0); }}>
              <option value="">All outcomes</option>
              {data?.outcomes.map((o) => <option key={o}>{o}</option>)}
            </select>
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
              <Empty title={filtered ? 'No messages match these filters' : 'No messages yet'}>
                {filtered && <button type="button" className="btn btn-sm mt-2" onClick={clear}>Clear filters</button>}
              </Empty>
            ) : (
              <div className={loading ? 'opacity-60 transition-opacity' : ''}>
                <RecordTable label="Messages" rows={data.rows} columns={COLUMNS} rowKey={(m, i) => `${m.file}-${i}`} onOpen={setOpen} />
              </div>
            )}
            <Pager total={data.total} limit={LIMIT} offset={offset} onOffset={setOffset} />
          </>
        )}
      </div>
      <Overlay open={open !== null} onClose={() => setOpen(null)} title={open !== null ? `Message from ${sender(open)}` : 'Message'} variant="drawer" description={open !== null ? fmtDateTime(open.sentAt ?? open.claimedAt) : undefined}>
        {open !== null && <MessageDetail m={open} />}
      </Overlay>
    </>
  );
}
