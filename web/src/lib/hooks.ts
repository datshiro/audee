import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';

export type Load<T> = { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void };

export function useLoad<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[], pollMs?: number): Load<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;

    const run = async (): Promise<void> => {
      clearTimeout(timer);
      ctrl?.abort();
      ctrl = new AbortController();
      setLoading(true);
      try {
        const value = await fetchRef.current(ctrl.signal);
        if (!alive) return;
        setData(value);
        setError(undefined);
      } catch (e) {
        if (!alive || (e instanceof DOMException && e.name === 'AbortError')) return;
        setError(errorMessage(e));
      }
      if (!alive) return;
      setLoading(false);
      if (pollMs !== undefined && !document.hidden) timer = setTimeout(() => void run(), pollMs);
    };

    const onVisible = (): void => {
      if (pollMs === undefined) return;
      if (document.hidden) clearTimeout(timer);
      else void run();
    };

    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [...deps, tick, pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
