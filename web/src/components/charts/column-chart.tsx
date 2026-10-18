import { useEffect, useRef, useState, type ReactNode } from 'react';

export type Segment = { value: number; color: string };
export type Column = { label: string; sublabel: string; segments: Segment[]; tooltip: ReactNode };

const HEIGHT = 168;
const PAD = { top: 12, right: 8, bottom: 26, left: 44 };

function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.5 };
  const rough = max / 3;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
}

function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export function ColumnChart({ columns, formatTick, label }: { columns: Column[]; formatTick: (n: number) => string; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (el === null) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totals = columns.map((c) => c.segments.reduce((n, s) => n + s.value, 0));
  const { top, step } = niceMax(Math.max(0, ...totals));
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const band = innerW / Math.max(1, columns.length);
  const barW = Math.max(4, Math.min(24, band * 0.62));
  const y = (v: number): number => PAD.top + innerH - (v / top) * innerH;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  const labelEvery = band < 30 ? 2 : 1;
  const hovered = hover === null ? undefined : columns[hover];

  return (
    <div ref={wrap} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={HEIGHT} role="img" aria-label={label} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-[var(--text-subtle)] text-[10px]">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          const cx = PAD.left + band * i + band / 2;
          let acc = 0;
          const visible = c.segments.filter((s) => s.value > 0);
          return (
            <g key={c.label} opacity={hover === null || hover === i ? 1 : 0.55}>
              {visible.map((s, j) => {
                const y0 = y(acc);
                acc += s.value;
                const y1 = y(acc);
                const gap = j > 0 ? 2 : 0;
                const h = Math.max(1, y0 - y1 - gap);
                const isTop = j === visible.length - 1;
                return isTop ? (
                  <path key={j} d={columnPath(cx - barW / 2, y0 - gap - h, barW, h, 4)} fill={s.color} />
                ) : (
                  <rect key={j} x={cx - barW / 2} y={y0 - gap - h} width={barW} height={h} fill={s.color} />
                );
              })}
              {i % labelEvery === (columns.length - 1) % labelEvery && (
                <text x={cx} y={HEIGHT - 8} textAnchor="middle" className="fill-[var(--text-subtle)] text-[10px]">
                  {c.label}
                </text>
              )}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hovered !== undefined && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-[var(--shadow-overlay)]"
          style={{ left: Math.min(Math.max(0, PAD.left + band * hover + band / 2 - 72), width - 160) }}
        >
          <div className="mb-1 font-medium">{hovered.sublabel}</div>
          {hovered.tooltip}
        </div>
      )}
    </div>
  );
}

export function TooltipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-muted">
        {color !== undefined && <span className="inline-block size-2 rounded-sm" style={{ background: color }} />}
        {label}
      </span>
      <span className="num font-medium text-ink">{value}</span>
    </div>
  );
}
