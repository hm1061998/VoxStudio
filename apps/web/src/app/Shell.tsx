import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { PlanDto } from '@voxstudio/contracts';
import type { MessageKey } from '../i18n/en';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { LanguageSelect } from '../components/ui';
import { useAuth } from './auth';
import { useTheme, type ThemeChoice } from './theme';
import { useUiMode } from './uiMode';

const icon = (d: string): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    className="h-5 w-5 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

interface NavItem {
  to: string;
  label: MessageKey;
  icon: ReactNode;
  end: boolean;
}

const MAIN: NavItem[] = [
  {
    to: '/',
    label: 'nav.dashboard',
    icon: icon('M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'),
    end: true,
  },
  {
    to: '/voices',
    label: 'nav.voices',
    icon: icon('M9 2h6v12H9zM5 11a7 7 0 0 0 14 0M12 18v4'),
    end: false,
  },
  {
    to: '/renders',
    label: 'nav.renders',
    icon: icon('M12 3v12m0 0l-4-4m4 4l4-4M4 21h16'),
    end: false,
  },
];
const TOOLS: NavItem[] = [
  {
    to: '/presets',
    label: 'nav.presets',
    icon: icon('M4 6h16M4 12h16M4 18h10'),
    end: false,
  },
  {
    to: '/pronunciation',
    label: 'nav.pronunciation',
    icon: icon('M4 20l5-14 5 14M6 15h6M16 8h5M18.5 8v10'),
    end: false,
  },
];
const ACCOUNT: NavItem = {
  to: '/settings',
  label: 'nav.settings',
  icon: icon('M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'),
  end: false,
};
/** Shown to administrators only (the server enforces the role on every admin route). */
const ADMIN: NavItem = {
  to: '/admin',
  label: 'nav.admin',
  icon: icon('M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z'),
  end: false,
};

/** Simple/Advanced switch (shared by the navigation and the studio top bar). */
export function ModeSwitch() {
  const { t } = useI18n();
  const { mode, setMode } = useUiMode();
  return (
    <div
      role="radiogroup"
      aria-label={t('mode.label')}
      className="inline-flex rounded-[10px] border border-line bg-panel-2 p-0.5 text-xs"
    >
      {(['simple', 'advanced'] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          title={t(m === 'simple' ? 'mode.simpleHint' : 'mode.advancedHint')}
          className={`rounded-lg px-2.5 py-1 font-semibold ${mode === m ? 'bg-panel text-accent-strong shadow-sm' : 'text-muted hover:text-fg'}`}
          onClick={() => setMode(m)}
        >
          {t(m === 'simple' ? 'mode.simple' : 'mode.advanced')}
        </button>
      ))}
    </div>
  );
}

/** Light / dark / follow the system. */
export function ThemeSwitch() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const options: ThemeChoice[] = ['system', 'light', 'dark'];
  return (
    <div
      role="radiogroup"
      aria-label={t('theme.label')}
      className="inline-flex rounded-[10px] border border-line bg-panel-2 p-0.5 text-xs"
    >
      {options.map((o) => (
        <button
          key={o}
          role="radio"
          aria-checked={theme === o}
          className={`rounded-lg px-2.5 py-1 font-semibold ${theme === o ? 'bg-panel text-accent-strong shadow-sm' : 'text-muted hover:text-fg'}`}
          onClick={() => setTheme(o)}
        >
          {t(`theme.${o}` as MessageKey)}
        </button>
      ))}
    </div>
  );
}

function navClass(isActive: boolean) {
  return `flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-accent/15 text-accent-strong font-semibold' : 'text-muted hover:bg-panel-2 hover:text-fg'}`;
}

/** Stored-audio meter in the navigation, so the allowance is never a surprise. */
function StorageMeter() {
  const { t } = useI18n();
  const plan = useQuery({ queryKey: ['plan'], queryFn: () => api<PlanDto>('/me/plan') });
  const p = plan.data;
  if (!p) return null;
  const pct = Math.min(100, Math.round((p.storageUsedBytes / Math.max(1, p.storageBytes)) * 100));
  const mb = (n: number) => `${Math.round(n / 1024 ** 2).toLocaleString()} MB`;
  return (
    <div>
      <div className="flex justify-between text-xs text-muted">
        <span>{t('nav.storage')}</span>
        <span className="font-mono">
          {mb(p.storageUsedBytes)} / {mb(p.storageBytes)}
        </span>
      </div>
      <div
        className="meter-track mt-1.5"
        role="img"
        aria-label={t('nav.storageUsed', { pct })}
        title={`${pct}%`}
      >
        <div
          className={`h-full rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Shell() {
  const { user, signOut } = useAuth();
  const { t } = useI18n();
  const admin = user?.role === 'admin';
  const link = (n: NavItem) => (
    <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => navClass(isActive)}>
      {n.icon}
      {t(n.label)}
    </NavLink>
  );
  return (
    <div className="flex h-full flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-1 focus:text-accent-ink"
      >
        {t('nav.skip')}
      </a>
      {/* Desktop and tablet: left rail */}
      <nav
        aria-label={t('nav.main')}
        className="hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-panel p-4 md:flex"
      >
        <div className="flex items-center gap-2.5 px-1">
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-accent-ink">
            <svg
              viewBox="0 0 24 24"
              className="h-[18px] w-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
            </svg>
          </span>
          <span className="text-lg font-bold tracking-tight">VoxStudio</span>
        </div>
        <div className="flex flex-col gap-1">{MAIN.map(link)}</div>
        <div className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-dim">
            {t('nav.tools')}
          </p>
          {TOOLS.map(link)}
        </div>
        <div className="flex flex-col gap-1">
          {link(ACCOUNT)}
          {admin && link(ADMIN)}
        </div>
        <div className="mt-auto flex flex-col gap-3">
          <StorageMeter />
          <LanguageSelect compact />
          <ThemeSwitch />
          <ModeSwitch />
          <div className="flex items-center gap-2.5 rounded-[10px] bg-panel-2 p-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-sm font-bold text-accent-ink">
              {(user?.displayName ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold" title={user?.email}>
                {user?.displayName}
              </p>
              <p className="truncate text-xs text-dim">{user?.email}</p>
            </div>
          </div>
          <button className="btn btn-sm" aria-label={t('nav.signOut')} onClick={() => void signOut()}>
            {t('nav.signOut')}
          </button>
        </div>
      </nav>
      <main id="main" className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      {/* Phone: bottom bar */}
      <nav
        aria-label={t('nav.main')}
        className="flex shrink-0 gap-1 overflow-x-auto border-t border-line bg-panel px-2 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-1.5 md:hidden"
      >
        {[...MAIN, ...TOOLS, ACCOUNT, ...(admin ? [ADMIN] : [])].map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex min-w-[4.5rem] flex-1 flex-col items-center gap-0.5 rounded-[10px] px-1 py-1.5 text-[11px] font-medium ${isActive ? 'bg-accent/15 text-accent-strong' : 'text-muted'}`
            }
          >
            {n.icon}
            <span className="max-w-full truncate">{t(n.label)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
