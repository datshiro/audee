import type { ReactNode } from 'react';
import { CircleAlert, Inbox, RefreshCw, TriangleAlert } from 'lucide-react';

export function ErrorState({ message, onRetry, compact }: { message: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div role="alert" className={`flex flex-col items-center gap-3 text-center ${compact ? 'py-6' : 'py-14'}`}>
      <CircleAlert className="size-6 text-danger" aria-hidden="true" />
      <div>
        <div className="font-medium">Couldn’t load this</div>
        <div className="mt-1 max-w-md break-words text-[0.8125rem] text-muted">{message}</div>
      </div>
      {onRetry !== undefined && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <span className="text-subtle">{icon ?? <Inbox className="size-6" aria-hidden="true" />}</span>
      <div className="font-medium">{title}</div>
      {children !== undefined && <div className="max-w-md text-[0.8125rem] text-muted">{children}</div>}
    </div>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-sunken ${className}`} aria-hidden="true" />;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-9 ${i % 3 === 2 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

export function Problems({ title, problems, onDismiss }: { title: string; problems: string[]; onDismiss?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 flex-none text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[0.8125rem] font-semibold text-danger">{title}</div>
          {problems.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[0.8125rem] text-ink">
              {problems.map((p) => (
                <li key={p} className="break-words mono text-xs">
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
        {onDismiss !== undefined && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
