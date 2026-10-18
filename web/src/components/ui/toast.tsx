import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';

type Tone = 'ok' | 'warn' | 'danger' | 'info';
type Toast = { id: number; tone: Tone; title: string; detail?: string };
type Push = (tone: Tone, title: string, detail?: string) => void;

const ToastContext = createContext<Push>(() => {});
export const useToast = (): Push => useContext(ToastContext);

const ICON = { ok: CheckCircle2, warn: TriangleAlert, danger: TriangleAlert, info: Info } as const;
const COLOR = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', info: 'text-info' } as const;
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>(
    (tone, title, detail) => {
      const id = ++seq;
      setToasts((t) => [...t.slice(-2), { id, tone, title, ...(detail !== undefined ? { detail } : {}) }]);
      setTimeout(() => dismiss(id), tone === 'danger' ? 9000 : 5500);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 top-16 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-auto sm:items-end" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div key={t.id} className="card pointer-events-auto flex w-full max-w-sm items-start gap-3 px-4 py-3 shadow-[var(--shadow-overlay)] [animation:toast-in_200ms_var(--ease-out)]">
              <Icon className={`mt-0.5 size-4 flex-none ${COLOR[t.tone]}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-[0.8125rem] font-medium">{t.title}</div>
                {t.detail !== undefined && <div className="mt-0.5 break-words text-xs text-muted">{t.detail}</div>}
              </div>
              <button type="button" className="btn btn-ghost btn-sm btn-icon -my-1 -mr-2" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
