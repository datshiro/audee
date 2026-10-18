import { useEffect, useState, type ComponentType } from 'react';
import { Activity, Boxes, HeartPulse, History, Inbox, LayoutDashboard, LogOut, Menu, Monitor, Moon, Settings, Sun, Users } from 'lucide-react';
import { hasToken, onSignedOut, setToken } from './api/client';
import { Overlay } from './components/ui/overlay';
import { ToastProvider } from './components/ui/toast';
import { useRoute, type Route } from './lib/router';
import { useTheme, type ThemePref } from './lib/theme';
import { CapabilitiesPage } from './pages/capabilities-page';
import { HealthPage } from './pages/health-page';
import { HistoryPage } from './pages/history-page';
import { JobsPage } from './pages/jobs-page';
import { MessagesPage } from './pages/messages-page';
import { OverviewPage } from './pages/overview-page';
import { PeoplePage } from './pages/people-page';
import { SettingsPage } from './pages/settings-page';
import { SignInPage } from './pages/sign-in-page';

const NAV: Array<{ route: Route; label: string; icon: ComponentType<{ className?: string }> }> = [
  { route: 'overview', label: 'Overview', icon: LayoutDashboard },
  { route: 'jobs', label: 'Jobs', icon: Activity },
  { route: 'history', label: 'History', icon: History },
  { route: 'messages', label: 'Messages', icon: Inbox },
  { route: 'capabilities', label: 'Capabilities', icon: Boxes },
  { route: 'people', label: 'People', icon: Users },
  { route: 'settings', label: 'Settings', icon: Settings },
  { route: 'health', label: 'Health', icon: HeartPulse },
];

const PAGES: Record<Route, ComponentType> = {
  overview: OverviewPage,
  jobs: JobsPage,
  history: HistoryPage,
  messages: MessagesPage,
  capabilities: CapabilitiesPage,
  people: PeoplePage,
  settings: SettingsPage,
  health: HealthPage,
};

export function App() {
  const [signedIn, setSignedIn] = useState(hasToken);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    onSignedOut(() => {
      setToken(null);
      setExpired(true);
      setSignedIn(false);
    });
  }, []);

  return <ToastProvider>{signedIn ? <Shell onSignOut={() => { setToken(null); setExpired(false); setSignedIn(false); }} /> : <SignInPage expired={expired} onSignedIn={() => setSignedIn(true)} />}</ToastProvider>;
}

function NavList({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  return (
    <ul className="space-y-0.5">
      {NAV.map(({ route: r, label, icon: Icon }) => (
        <li key={r}>
          <a className="nav-link" href={`#/${r}`} aria-current={r === route ? 'page' : undefined} onClick={onNavigate}>
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </a>
        </li>
      ))}
    </ul>
  );
}

const THEMES: Array<{ value: ThemePref; label: string; icon: ComponentType<{ className?: string }> }> = [
  { value: 'system', label: 'System theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
];

function ThemeSwitch() {
  const [pref, setPref] = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md border border-line bg-sunken p-0.5">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          aria-label={label}
          title={label}
          onClick={() => setPref(value)}
          className={`grid size-7 place-items-center rounded ${pref === value ? 'bg-surface text-ink shadow-sm' : 'text-subtle hover:text-ink'}`}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="currentColor" className="text-ink" />
        <path d="M8 20v-4M13 22v-8M18 19v-6M23 24V9" stroke="var(--bg)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="mono text-[0.8125rem] font-semibold tracking-tight">audee</span>
      <span className="text-xs text-subtle">admin</span>
    </div>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const Page = PAGES[route];
  const current = NAV.find((n) => n.route === route);

  useEffect(() => {
    document.title = `${current?.label ?? 'Overview'} · audee admin`;
    return () => {
      document.title = 'audee admin';
    };
  }, [current]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[224px_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface px-3 py-4 md:flex">
        <div className="px-2 pb-5">
          <Brand />
        </div>
        <nav aria-label="Main" className="flex-1">
          <NavList route={route} />
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-line px-1 pt-3">
          <ThemeSwitch />
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
            <LogOut className="size-3.5" aria-hidden="true" /> Sign out
          </button>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur md:hidden">
        <Brand />
        <button type="button" className="btn btn-sm" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <Menu className="size-4" aria-hidden="true" />
          {current?.label ?? 'Menu'}
        </button>
      </header>
      <Overlay open={menuOpen} onClose={() => setMenuOpen(false)} title="Go to" variant="sheet">
        <nav aria-label="Main">
          <NavList route={route} onNavigate={() => setMenuOpen(false)} />
        </nav>
        <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
          <ThemeSwitch />
          <button type="button" className="btn btn-sm" onClick={onSignOut}>
            <LogOut className="size-3.5" aria-hidden="true" /> Sign out
          </button>
        </div>
      </Overlay>

      <main id="main" className="min-w-0 px-4 pb-28 pt-5 sm:px-6 md:px-8 md:pt-8" tabIndex={-1}>
        <div className="mx-auto max-w-[1240px]">
          <Page key={route} />
        </div>
      </main>
    </div>
  );
}
