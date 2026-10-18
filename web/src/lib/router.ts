import { useEffect, useState } from 'react';
import { hasUnsavedChanges } from './config-draft';

export const ROUTES = ['overview', 'jobs', 'history', 'messages', 'capabilities', 'people', 'settings', 'health'] as const;
export type Route = (typeof ROUTES)[number];

const parse = (): Route => {
  const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : 'overview';
};

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    let current = parse();
    const onHash = (): void => {
      const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
      if (name !== '' && !(ROUTES as readonly string[]).includes(name)) return;
      const next = parse();
      if (next === current) return;
      if (hasUnsavedChanges() && !window.confirm('You have unsaved config changes on this page. Leave and discard them?')) {
        history.replaceState(null, '', `#/${current}`);
        return;
      }
      current = next;
      setRoute(next);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
