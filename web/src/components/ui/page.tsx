import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[1.375rem] font-semibold leading-tight tracking-tight">{title}</h1>
        {description !== undefined && <p className="mt-1 text-[0.8125rem] text-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button type="button" className="btn btn-sm" onClick={onClick} disabled={loading} aria-label="Refresh">
      <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span>Refresh</span>
    </button>
  );
}

export function Section({ title, description, actions, children, className = '' }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`} aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
          {description !== undefined && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}
