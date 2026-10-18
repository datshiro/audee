export type BarRow = { key: string; label: string; value: number; display: string; detail?: string };

export function BarList({ rows, caption }: { rows: BarRow[]; caption: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const hasDetail = rows.some((r) => r.detail !== undefined);
  return (
    <table className="w-full table-fixed text-[0.8125rem]">
      <caption className="sr-only">{caption}</caption>
      <colgroup>
        <col className="w-[34%] sm:w-[24%]" />
        <col />
        <col className="w-20" />
        {hasDetail && <col className="hidden w-0 sm:table-column sm:w-[13.5rem]" />}
      </colgroup>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row" className="truncate py-1.5 pr-3 text-left font-normal" title={r.label}>
              <span className="mono text-xs">{r.label}</span>
            </th>
            <td className="py-1.5 pr-3">
              <div className="h-2.5 w-full rounded-sm bg-sunken">
                <div className="h-2.5 rounded-sm bg-[var(--series-1)]" style={{ width: `${max > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%` }} />
              </div>
            </td>
            <td className="num whitespace-nowrap py-1.5 text-right font-medium">{r.display}</td>
            {hasDetail && <td className="num hidden truncate py-1.5 pl-3 text-right text-xs text-subtle sm:table-cell" title={r.detail}>{r.detail}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
