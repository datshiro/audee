import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

type Props = { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; variant?: 'modal' | 'drawer' | 'sheet'; description?: ReactNode };

export function Overlay({ open, onClose, title, children, footer, variant = 'modal', description }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<Element | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      trigger.current = document.activeElement;
      d.showModal();
      document.body.style.overflow = 'hidden';
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    const onClosed = (): void => {
      document.body.style.overflow = '';
      if (trigger.current instanceof HTMLElement) trigger.current.focus();
    };
    d.addEventListener('close', onClosed);
    return () => d.removeEventListener('close', onClosed);
  }, []);

  useEffect(() => () => {
    document.body.style.overflow = '';
  }, []);

  const titleId = `${title.replace(/\W+/g, '-')}-title`;
  return (
    <dialog
      ref={ref}
      className={variant}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className={`flex flex-col ${variant === 'drawer' ? 'h-full' : 'max-h-[inherit]'}`}>
          <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold leading-tight">
                {title}
              </h2>
              {description !== undefined && <div className="mt-1 text-[0.8125rem] text-muted">{description}</div>}
            </div>
            <button type="button" className="btn btn-ghost btn-sm btn-icon -mr-2 -mt-1" aria-label="Close" onClick={onClose}>
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer !== undefined && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

type ConfirmProps = { open: boolean; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void };

export function Confirm({ open, title, children, confirmLabel, danger, busy, onConfirm, onClose }: ConfirmProps) {
  return (
    <Overlay
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[0.875rem] leading-relaxed text-muted">{children}</div>
    </Overlay>
  );
}
