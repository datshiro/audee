import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export type ColumnDef<T> = { key: string; header: string; render: (row: T) => ReactNode; align?: 'right'; primary?: boolean; hideOnCard?: boolean; width?: string };

export function RecordTable<T>({ rows, columns, rowKey, onOpen, label }: { rows: T[]; columns: ColumnDef<T>[]; rowKey: (row: T, i: number) => string; onOpen: (row: T) => void; label: string }) {
  return (
    <>
      <div className="hidden max-h-[70vh] overflow-auto lg:block">
        <table className="table" aria-label={label}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'r' : ''} style={c.width !== undefined ? { width: c.width } : undefined}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                className="is-clickable"
                tabIndex={0}
                onClick={() => onOpen(row)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(row);
                  }
                }}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`${c.align === 'right' ? 'r' : ''} max-w-[22rem]`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-[var(--border)] lg:hidden" aria-label={label}>
        {rows.map((row, i) => (
          <li key={rowKey(row, i)}>
            <button type="button" className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-sunken" onClick={() => onOpen(row)}>
              {columns
                .filter((c) => c.hideOnCard !== true)
                .map((c) => (
                  <div key={c.key} className={`flex min-w-0 items-center justify-between gap-3 ${c.primary ? '' : 'text-[0.8125rem]'}`}>
                    <span className="flex-none text-xs text-subtle">{c.header}</span>
                    <span className="min-w-0 truncate text-right">{c.render(row)}</span>
                  </div>
                ))}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pager({ total, limit, offset, onOffset }: { total: number; limit: number; offset: number; onOffset: (n: number) => void }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3" aria-label="Pagination">
      <span className="num text-xs text-muted">
        {from}–{to} of {total.toLocaleString('en')}
      </span>
      <div className="flex gap-2">
        <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>
          <ChevronLeft className="size-3.5" aria-hidden="true" /> Newer
        </button>
        <button type="button" className="btn btn-sm" disabled={to >= total} onClick={() => onOffset(offset + limit)}>
          Older <ChevronRight className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

export function DetailList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-[var(--border)]">
      {items.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-2.5 text-[0.8125rem]">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TagList({ items, empty = 'None' }: { items: string[] | undefined; empty?: string }) {
  if (items === undefined || items.length === 0) return <span className="text-subtle">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((t, i) => (
        <li key={`${t}-${i}`} className="mono rounded bg-sunken px-1.5 py-0.5 text-xs">
          {t}
        </li>
      ))}
    </ul>
  );
}

export function downloadCsv(filename: string, rows: Array<Record<string, unknown>>): void {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const text = [keys.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
