import { useState } from 'react';
import { CircleCheck, CircleX, RotateCw, TriangleAlert } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import type { DoctorResult, ReloadResult } from '../api/types';
import { Spinner } from '../components/ui/controls';
import { Confirm } from '../components/ui/overlay';
import { PageHeader, RefreshButton, Section } from '../components/ui/page';
import { Empty, ErrorState, LoadingBlock } from '../components/ui/states';
import { useToast } from '../components/ui/toast';
import { useLoad } from '../lib/hooks';

type DoctorCheck = DoctorResult['checks'][number];
type Level = 'fail' | 'warn' | 'pass';
const levelOf = (c: DoctorCheck): Level => (!c.ok ? 'fail' : c.detail.startsWith('warning:') ? 'warn' : 'pass');
const ORDER: Record<Level, number> = { fail: 0, warn: 1, pass: 2 };
const CHIP: Record<Level, string> = { fail: 'chip-danger', warn: 'chip-warn', pass: 'chip-ok' };

function summary(checks: DoctorCheck[]): string {
  const n = { fail: 0, warn: 0, pass: 0 };
  for (const c of checks) n[levelOf(c)]++;
  if (n.fail === 0 && n.warn === 0) return `All ${checks.length} checks pass`;
  return [n.fail > 0 && `${n.fail} failing`, n.warn > 0 && `${n.warn} ${n.warn === 1 ? 'warning' : 'warnings'}`, `${n.pass} pass`].filter(Boolean).join(' · ');
}

export function HealthPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad((signal) => api<DoctorResult>('/api/doctor', { signal }), []);
  const [confirm, setConfirm] = useState(false);
  const [reloading, setReloading] = useState(false);

  const doReload = async (): Promise<void> => {
    setReloading(true);
    try {
      const r = await api<ReloadResult>('/api/reload', { method: 'POST' });
      if (r.ok) toast('ok', 'Reloaded config.yaml', 'The watcher restarted with the file on disk.');
      else toast('danger', 'Reload failed; the previous config keeps running', r.error);
      setConfirm(false);
      reload();
    } catch (e) {
      toast('danger', 'Reload failed', errorMessage(e));
    } finally {
      setReloading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Health"
        description="audee doctor: the same checks the CLI runs."
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={() => setConfirm(true)}>
              <RotateCw className="size-3.5" aria-hidden="true" /> Reload config
            </button>
            <RefreshButton onClick={reload} loading={loading} />
          </>
        }
      />
      <Section
        title="Checks"
        description={data === undefined ? undefined : summary(data.checks)}
        actions={loading && data !== undefined ? <Spinner className="size-4 text-subtle" /> : undefined}
      >
        {data === undefined ? (
          error !== undefined ? <ErrorState compact message={error} onRetry={reload} /> : <LoadingBlock rows={5} />
        ) : data.checks.length === 0 ? (
          <Empty title="No checks reported" />
        ) : (
          <ul className={`divide-y divide-[var(--border)] ${loading ? 'opacity-60' : ''}`}>
            {[...data.checks].sort((a, b) => ORDER[levelOf(a)] - ORDER[levelOf(b)]).map((c) => (
              <li key={c.name} className="flex items-start gap-3 py-3">
                {levelOf(c) === 'fail' ? (
                  <CircleX className="mt-0.5 size-4 flex-none text-danger" aria-hidden="true" />
                ) : levelOf(c) === 'warn' ? (
                  <TriangleAlert className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
                ) : (
                  <CircleCheck className="mt-0.5 size-4 flex-none text-ok" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.8125rem] font-medium">{c.name}</span>
                    <span className={`chip ${CHIP[levelOf(c)]}`}>{levelOf(c)}</span>
                  </div>
                  {c.detail !== '' && <p className="mt-0.5 break-words text-[0.8125rem] text-muted">{c.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Confirm open={confirm} title="Reload config.yaml from disk?" confirmLabel="Reload" busy={reloading} onConfirm={() => void doReload()} onClose={() => setConfirm(false)}>
        audee re-reads config.yaml and checks it like a save (schema, fence rules, doctor). If it passes, running sessions are stopped and restart from the beginning, spending their budget again. If it fails, the current config keeps running.
      </Confirm>
    </>
  );
}
