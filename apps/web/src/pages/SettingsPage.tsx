import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { PlanDto } from '@voxstudio/contracts';
import type { MessageKey } from '../i18n/en';
import { api, describeError } from '../api/client';
import { useAuth } from '../app/auth';
import { ModeSwitch, ThemeSwitch } from '../app/Shell';
import { LanguageSelect } from '../components/ui';
import { useI18n } from '../i18n';

const SECTIONS: { to: string; label: MessageKey }[] = [
  { to: 'profile', label: 'acct.profile' },
  { to: 'plan', label: 'acct.plan' },
  { to: 'password', label: 'acct.password' },
  { to: 'devices', label: 'acct.devices' },
  { to: 'data', label: 'acct.data' },
];

/** The account area: one section per page, chosen from a menu (a side menu on wide screens, tabs on narrow ones). */
export function SettingsLayout() {
  const { t } = useI18n();
  return (
    <div className="h-full overflow-auto p-4 scroll-thin md:p-8">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
        <p className="mt-1 text-muted">{t('acct.intro')}</p>
      </header>
      <div className="grid max-w-5xl gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label={t('acct.menu')}
          className="flex gap-1 overflow-x-auto border-b border-line pb-2 lg:sticky lg:top-0 lg:flex-col lg:self-start lg:overflow-visible lg:border-b-0 lg:pb-0"
        >
          {SECTIONS.map((s) => (
            <NavLink
              key={s.to}
              to={`/settings/${s.to}`}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-[10px] px-3 py-2 text-sm ${isActive ? 'bg-accent/15 font-semibold text-accent-strong' : 'text-muted hover:bg-panel-2 hover:text-fg'}`
              }
            >
              {t(s.label)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 space-y-4">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export function SettingsIndex() {
  return <Navigate to="/settings/profile" replace />;
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card max-w-xl space-y-4 p-5" aria-labelledby={id}>
      <div>
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Status({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <p role="status" className={`text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`}>
      {msg.text}
    </p>
  );
}

function useRun() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: describeError(e) });
      return false;
    }
  };
  return { msg, run };
}

export function ProfileSection() {
  const { user, reload } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState(user?.displayName ?? '');
  const { msg, run } = useRun();
  return (
    <>
      <Section id="profile-h" title={t('settings.profile')} hint={t('acct.profileHint')}>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => {
              await api('/auth/me', { method: 'PATCH', body: { displayName: name } });
              await reload();
            }, t('settings.profileSaved'));
          }}
        >
          <p className="text-sm text-muted">
            {user?.email} · {t('settings.role', { role: user?.role ?? '' })}
          </p>
          <div>
            <label className="label" htmlFor="dn">
              {t('auth.displayName')}
            </label>
            <input
              id="dn"
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button className="btn btn-primary">{t('settings.saveProfile')}</button>
          <Status msg={msg} />
        </form>
      </Section>
      <Section id="prefs-h" title={t('settings.prefs')} hint={t('acct.prefsHint')}>
        <div className="space-y-4">
          <LanguageSelect />
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>{t('theme.label')}</span>
            <ThemeSwitch />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>{t('mode.label')}</span>
            <ModeSwitch />
          </div>
          <p className="text-xs text-dim">{t('mode.simpleHint')}</p>
          <p className="text-xs text-dim">{t('mode.advancedHint')}</p>
        </div>
      </Section>
      {user?.role === 'admin' && (
        <p className="text-sm">
          <Link className="text-accent-strong underline" to="/admin">
            {t('settings.adminLink')}
          </Link>
        </p>
      )}
    </>
  );
}

export function PasswordSection() {
  const { t } = useI18n();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const { msg, run } = useRun();
  return (
    <Section id="pw-h" title={t('settings.password')} hint={t('acct.passwordHint')}>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run(
            () => api('/auth/password', { method: 'POST', body: pw }),
            t('settings.passwordChanged'),
          ).then((ok) => ok && setPw({ currentPassword: '', newPassword: '' }));
        }}
      >
        <div>
          <label className="label" htmlFor="cp">
            {t('settings.currentPassword')}
          </label>
          <input
            id="cp"
            type="password"
            autoComplete="current-password"
            className="input"
            value={pw.currentPassword}
            onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="np">
            {t('auth.newPassword')}
          </label>
          <input
            id="np"
            type="password"
            autoComplete="new-password"
            minLength={10}
            className="input"
            value={pw.newPassword}
            onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
          />
          <p className="mt-1.5 text-xs text-dim">{t('acct.newPasswordHint')}</p>
        </div>
        <button className="btn btn-primary">{t('settings.changePassword')}</button>
        <Status msg={msg} />
      </form>
    </Section>
  );
}

export function DevicesSection() {
  const { t } = useI18n();
  const [others, setOthers] = useState(0);
  const { msg, run } = useRun();
  return (
    <Section id="sess-h" title={t('settings.sessions')} hint={t('settings.sessionsHint')}>
      <button
        className="btn"
        onClick={() =>
          void run(
            async () => {
              const r = await api<{ revoked: number }>('/auth/logout-others', { method: 'POST' });
              setOthers(r.revoked);
            },
            t('settings.signedOutOthers', { n: others }),
          )
        }
      >
        {t('settings.signOutOthers')}
      </button>
      {msg && (
        <Status msg={msg.ok ? { ok: true, text: t('settings.signedOutOthers', { n: others }) } : msg} />
      )}
    </Section>
  );
}

export function DataSection() {
  const { t } = useI18n();
  const plan = useQuery({ queryKey: ['plan'], queryFn: () => api<PlanDto>('/me/plan') });
  return (
    <Section id="data-h" title={t('acct.data')} hint={t('acct.dataHint')}>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">{t('plan.storageMeter')}</dt>
          <dd className="font-mono">{plan.data ? formatBytes(plan.data.storageUsedBytes) : '…'}</dd>
        </div>
      </dl>
      <p className="text-sm text-muted">{t('acct.deleteNote')}</p>
    </Section>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / 1024 ** 2))} MB`;
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100));
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{label}</h3>
        <span className="font-mono text-sm text-muted">{pct}%</span>
      </div>
      <meter className="sr-only" min={0} max={max} value={Math.min(value, max)} aria-label={label} />
      <div className="meter-track mt-3" aria-hidden>
        <div
          className={`h-full rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 font-mono text-sm">{text}</p>
    </div>
  );
}

export function PlanSection() {
  const { t, lang } = useI18n();
  const plan = useQuery({ queryKey: ['plan'], queryFn: () => api<PlanDto>('/me/plan') });
  if (!plan.data) return null;
  const p = plan.data;
  const aiText =
    p.aiMonthlyChars === null
      ? t('plan.aiUnlimited', { used: p.aiUsedChars.toLocaleString(lang) })
      : t('plan.ai', {
          used: p.aiUsedChars.toLocaleString(lang),
          limit: p.aiMonthlyChars.toLocaleString(lang),
        });
  return (
    <>
      <section className="card p-5" aria-labelledby="plan-h">
        <h2 id="plan-h" className="text-lg font-semibold">
          {t('plan.title')}:{' '}
          <span className="text-accent-strong">{t(`plan.name.${p.plan}` as MessageKey)}</span>
        </h2>
        <p className="mt-1 text-sm text-muted">{t('plan.priority', { n: p.priority })}</p>
        <p className="mt-1 text-sm text-dim">{t('plan.noteAdmin')}</p>
      </section>
      <div className="grid gap-4 sm:grid-cols-3">
        {p.aiMonthlyChars !== null && (
          <Meter
            label={t('plan.aiMeter')}
            value={p.aiUsedChars}
            max={p.aiMonthlyChars}
            text={`${p.aiUsedChars.toLocaleString(lang)} / ${p.aiMonthlyChars.toLocaleString(lang)}`}
          />
        )}
        <Meter
          label={t('plan.storageMeter')}
          value={p.storageUsedBytes}
          max={p.storageBytes}
          text={`${formatBytes(p.storageUsedBytes)} / ${formatBytes(p.storageBytes)}`}
        />
        <Meter
          label={t('plan.jobsMeter')}
          value={p.pendingJobs}
          max={p.maxPendingJobs}
          text={`${p.pendingJobs} / ${p.maxPendingJobs}`}
        />
      </div>
      <ul className="max-w-xl space-y-1 text-sm text-muted">
        <li>{aiText}</li>
        <li>{t(p.heavyExports ? 'plan.heavyYes' : 'plan.heavyNo')}</li>
      </ul>
    </>
  );
}
