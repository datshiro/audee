import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { api, ApiError, errorMessage, setToken } from '../api/client';
import type { Overview } from '../api/types';
import { Spinner } from '../components/ui/controls';

export function SignInPage({ onSignedIn, expired }: { onSignedIn: () => void; expired: boolean }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const token = value.trim().replace(/^.*#token=/, '');
    if (token === '') return;
    setBusy(true);
    setError(undefined);
    setToken(token);
    try {
      await api<Overview>('/api/overview');
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        setError('That token was not accepted. Run `audee dashboard` again for a fresh link.');
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <div className="card w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-ink text-bg">
            <KeyRound className="size-4" aria-hidden="true" />
          </span>
          <span className="mono text-sm font-semibold tracking-tight">audee admin</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{expired ? 'Your sign-in expired' : 'Sign in to the dashboard'}</h1>
        <p className="mt-2 text-[0.875rem] leading-relaxed text-muted">
          Run <code className="rounded bg-sunken px-1.5 py-0.5 text-[0.8125rem] text-ink">audee dashboard</code> on the machine running the daemon to get a sign-in link, and open it here.
        </p>
        <form className="mt-6 space-y-3" onSubmit={(e) => void submit(e)}>
          <label className="label" htmlFor="token">
            Or paste the token (or the whole link)
          </label>
          <input
            id="token"
            className="input mono"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error !== undefined}
            aria-describedby={error !== undefined ? 'token-error' : undefined}
            placeholder="http://127.0.0.1:7420/#token=…"
          />
          {error !== undefined && (
            <p id="token-error" role="alert" className="text-[0.8125rem] text-danger">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary w-full" disabled={busy || value.trim() === ''}>
            {busy ? <Spinner /> : null}
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
