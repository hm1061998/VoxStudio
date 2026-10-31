import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import type { MessageKey } from '../i18n/en';
import { useI18n } from '../i18n';
import { LanguageSelect } from '../components/ui';
import { useAuth } from './auth';
import { useUiMode } from './uiMode';

const NAV: { to: string; label: MessageKey; icon: string; end: boolean }[] = [
  { to: '/', label: 'nav.dashboard', icon: '▦', end: true },
  { to: '/voices', label: 'nav.voices', icon: '◉', end: false },
  { to: '/presets', label: 'nav.presets', icon: '◈', end: false },
  { to: '/pronunciation', label: 'nav.pronunciation', icon: 'Aa', end: false },
  { to: '/renders', label: 'nav.renders', icon: '⇵', end: false },
  { to: '/settings', label: 'nav.settings', icon: '⚙', end: false },
];

/** Shown to administrators only (the server enforces the role on every admin route). */
const ADMIN_NAV: (typeof NAV)[number] = { to: '/admin', label: 'nav.admin', icon: '⛨', end: false };

/** Simple/Advanced switch (shared by the navigation and the studio top bar). */
export function ModeSwitch() {
  const { t } = useI18n();
  const { mode, setMode } = useUiMode();
  return (
    <div
      role="radiogroup"
      aria-label={t('mode.label')}
      className="inline-flex rounded-md border border-line p-0.5 text-xs"
    >
      {(['simple', 'advanced'] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          title={t(m === 'simple' ? 'mode.simpleHint' : 'mode.advancedHint')}
          className={`rounded px-2 py-0.5 ${mode === m ? 'bg-accent text-accent-ink' : 'text-muted hover:text-fg'}`}
          onClick={() => setMode(m)}
        >
          {t(m === 'simple' ? 'mode.simple' : 'mode.advanced')}
        </button>
      ))}
    </div>
  );
}

export function Shell() {
  const { user, signOut } = useAuth();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1100);
  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-1 focus:text-accent-ink"
      >
        {t('nav.skip')}
      </a>
      <nav
        aria-label={t('nav.main')}
        className={`flex shrink-0 flex-col border-r border-line bg-panel transition-[width] ${collapsed ? 'w-14' : 'w-56'}`}
      >
        <div className="flex h-12 items-center gap-2 border-b border-line px-3">
          <button
            className="btn btn-ghost btn-sm"
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            ☰
          </button>
          {!collapsed && <span className="font-semibold tracking-tight">VoxStudio</span>}
        </div>
        <ul className="flex-1 space-y-0.5 p-2">
          {[...NAV, ...(user?.role === 'admin' ? [ADMIN_NAV] : [])].map((n) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                end={n.end}
                title={t(n.label)}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-md px-2.5 py-2 text-sm ${isActive ? 'bg-accent/15 text-accent-strong' : 'text-muted hover:bg-panel-2 hover:text-fg'}`
                }
              >
                <span aria-hidden className="w-5 text-center font-mono text-xs">
                  {n.icon}
                </span>
                {collapsed ? <span className="sr-only">{t(n.label)}</span> : t(n.label)}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t border-line p-2">
          {!collapsed && (
            <>
              <LanguageSelect compact />
              <ModeSwitch />
              <p className="truncate px-1 text-xs text-muted" title={user?.email}>
                {user?.displayName}
              </p>
            </>
          )}
          <button
            className="btn btn-ghost btn-sm w-full justify-start"
            aria-label={t('nav.signOut')}
            onClick={() => void signOut()}
          >
            <span aria-hidden>⎋</span>
            {!collapsed && t('nav.signOut')}
          </button>
        </div>
      </nav>
      <main id="main" className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
