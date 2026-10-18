import { useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { api, ApiError, errorMessage } from '../api/client';
import type { Check, ConfigApplyResult, ConfigView } from '../api/types';
import { useDraft, type Draft } from '../lib/config-draft';
import { useLoad, type Load } from '../lib/hooks';
import { Spinner } from './ui/controls';
import { Confirm } from './ui/overlay';
import { Problems } from './ui/states';
import { useToast } from './ui/toast';

export function useConfigEditor(): { cfg: Load<ConfigView>; draft: Draft } {
  const cfg = useLoad((signal) => api<ConfigView>('/api/config', { signal }), []);
  const draft = useDraft(cfg.data?.raw);
  return { cfg, draft };
}

type Feedback = { kind: 'problems'; title: string; problems: string[] } | { kind: 'checks'; failing: Check[] } | null;

export function PendingBar({ draft, onSaved }: { draft: Draft; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'validate' | 'save' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const n = draft.ops.length;

  if (n === 0 && feedback === null) return null;

  const fail = (e: unknown, title: string): void => {
    if (e instanceof ApiError && e.problems.length > 0) setFeedback({ kind: 'problems', title: e.message || title, problems: e.problems });
    else setFeedback({ kind: 'problems', title, problems: [errorMessage(e)] });
  };

  const validate = async (): Promise<void> => {
    setBusy('validate');
    setFeedback(null);
    try {
      const r = await api<Partial<ConfigApplyResult>>('/api/config/validate', { method: 'POST', body: { ops: draft.ops } });
      const failing = (r.checks ?? []).filter((c) => !c.ok);
      if (failing.length > 0) setFeedback({ kind: 'checks', failing });
      toast(failing.length > 0 ? 'warn' : 'ok', failing.length > 0 ? 'Valid, with failing checks' : 'Changes are valid', failing.length > 0 ? `${failing.length} health check(s) fail with this config.` : undefined);
    } catch (e) {
      fail(e, 'These changes are not valid');
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    setBusy('save');
    setFeedback(null);
    try {
      const r = await api<ConfigApplyResult>('/api/config', { method: 'PATCH', body: { ops: draft.ops } });
      setConfirm(false);
      draft.discard();
      toast(r.reloaded ? 'ok' : 'warn', r.reloaded ? 'Saved and reloaded' : 'Saved, but not reloaded', r.backup !== undefined ? `Backup: ${r.backup}` : undefined);
      const failing = r.checks.filter((c) => !c.ok);
      if (failing.length > 0) setFeedback({ kind: 'checks', failing });
      onSaved();
    } catch (e) {
      setConfirm(false);
      if (e instanceof ApiError && e.status >= 500 && e.message.startsWith('saved')) {
        draft.discard();
        setFeedback({ kind: 'problems', title: e.message, problems: [] });
        onSaved();
      } else fail(e, 'Not saved');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sticky bottom-3 z-20 mt-6">
      <div className="card space-y-3 border-[var(--border-strong)] p-3 shadow-[var(--shadow-overlay)] sm:p-4">
        {feedback?.kind === 'problems' && <Problems title={feedback.title} problems={feedback.problems} onDismiss={() => setFeedback(null)} />}
        {feedback?.kind === 'checks' && (
          <div role="status" className="rounded-lg border border-[var(--warn-strong)] bg-warn-soft px-4 py-3 text-[0.8125rem]">
            <div className="flex items-center gap-2 font-semibold text-warn">
              <TriangleAlert className="size-4" aria-hidden="true" /> Health checks failing with this config
            </div>
            <ul className="mt-1.5 space-y-0.5 pl-6">
              {feedback.failing.map((c) => (
                <li key={c.name}>
                  <span className="font-medium">{c.name}</span>: <span className="text-muted">{c.detail}</span>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-ghost btn-sm mt-1" onClick={() => setFeedback(null)}>
              Dismiss
            </button>
          </div>
        )}
        {n > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[0.8125rem] font-medium">
              <span className="size-2 rounded-full bg-[var(--warn-strong)]" aria-hidden="true" />
              {n} unsaved change{n === 1 ? '' : 's'}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => { draft.discard(); setFeedback(null); }}>
                Discard
              </button>
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void validate()}>
                {busy === 'validate' ? <Spinner className="size-3.5" /> : <CircleCheck className="size-3.5" aria-hidden="true" />}
                Validate
              </button>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => setConfirm(true)}>
                Save &amp; reload
              </button>
            </div>
          </div>
        )}
      </div>
      <Confirm open={confirm} title="Save and reload audee?" confirmLabel="Save & reload" busy={busy === 'save'} onConfirm={() => void save()} onClose={() => setConfirm(false)}>
        <p>
          config.yaml is backed up, rewritten with {n} change{n === 1 ? '' : 's'}, and reloaded. Running sessions are stopped and restart from the beginning after the reload, so each one spends its budget again.
        </p>
      </Confirm>
    </div>
  );
}
