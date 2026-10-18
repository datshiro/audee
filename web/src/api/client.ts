const TOKEN_KEY = 'audee.token';
let token: string | null = null;
let onUnauthorized: () => void = () => {};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly problems: string[] = []) {
    super(message);
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(value: string | null): void {
  token = value;
  try {
    if (value === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // storage unavailable: keep the token in memory for this tab
  }
}

export function hasToken(): boolean {
  return token !== null && token !== '';
}

export function bootToken(): void {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match?.[1] !== undefined) {
    setToken(decodeURIComponent(match[1]));
    history.replaceState(null, '', `${location.pathname}${location.search}#/overview`);
  } else {
    token = readStored();
  }
}

export function onSignedOut(handler: () => void): void {
  onUnauthorized = handler;
}

// A save or reload waits for doctor and for running sessions to stop; past this, report it instead of spinning.
const TIMEOUT_MS = 120_000;

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal !== undefined ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') throw new ApiError(0, 'audee did not answer in 2 minutes. Check the Overview page before trying again.');
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Cannot reach audee. Is `audee serve` running?');
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) return body as T;
  const err = (body ?? {}) as { error?: unknown; problems?: unknown };
  const message = typeof err.error === 'string' ? err.error : `Request failed (${res.status})`;
  const problems = Array.isArray(err.problems) ? err.problems.map(String) : [];
  if (res.status === 401) onUnauthorized();
  throw new ApiError(res.status, message, problems);
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
