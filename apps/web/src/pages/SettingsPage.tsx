import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { PlanDto } from '@voxstudio/contracts';
import type { MessageKey } from '../i18n/en';
import { api, describeError } from '../api/client';
import { useAuth } from '../app/auth';
import { ModeSwitch } from '../app/Shell';
import { LanguageSelect } from '../components/ui';
import { useI18n } from '../i18n';

export function SettingsPage() {
  const { user, reload } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState(user?.displayName ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [others, setOthers] = useState<number | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: describeError(e) });
    }
  };
  return (
    <div className="h-full overflow-auto p-6 scroll-thin">
      <h1 className="mb-4 text-lg font-semibold">{t('settings.title')}</h1>
      <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
        <section className="card p-4" aria-labelledby="prefs-h">
          <h2 id="prefs-h" className="mb-3 font-medium">
            {t('settings.prefs')}
          </h2>
          <div className="space-y-3">
            <LanguageSelect />
            <div className="flex items-center gap-3 text-xs text-muted">
              <span>{t('mode.label')}</span>
              <ModeSwitch />
            </div>
            <p className="text-xs text-dim">{t('mode.simpleHint')}</p>
            <p className="text-xs text-dim">{t('mode.advancedHint')}</p>
          </div>
        </section>
        <section className="card p-4" aria-labelledby="profile-h">
          <h2 id="profile-h" className="mb-3 font-medium">
            {t('settings.profile')}
          </h2>
          <form
            className="space-y-3"
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
            <button className="btn">{t('settings.saveProfile')}</button>
          </form>
        </section>
        <section className="card p-4" aria-labelledby="pw-h">
          <h2 id="pw-h" className="mb-3 font-medium">
            {t('settings.password')}
          </h2>
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(
                () => api('/auth/password', { method: 'POST', body: pw }),
                t('settings.passwordChanged'),
              ).then(() => setPw({ currentPassword: '', newPassword: '' }));
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
            </div>
            <button className="btn">{t('settings.changePassword')}</button>
          </form>
        </section>
      </div>
      {msg && (
        <p role="status" className={`mt-3 text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`}>
          {msg.text}
        </p>
      )}
      <section className="card mt-4 max-w-5xl p-4" aria-labelledby="sess-h">
        <h2 id="sess-h" className="mb-1 font-medium">
          {t('settings.sessions')}
        </h2>
        <p className="mb-3 text-xs text-dim">{t('settings.sessionsHint')}</p>
        <button
          className="btn"
          onClick={() =>
            void run(
              async () => {
                const r = await api<{ revoked: number }>('/auth/logout-others', { method: 'POST' });
                setOthers(r.revoked);
              },
              t('settings.signedOutOthers', { n: others ?? 0 }),
            )
          }
        >
          {t('settings.signOutOthers')}
        </button>
      </section>
      <PlanSection />
      {user?.role === 'admin' && (
        <p className="mt-6 text-sm">
          <Link className="text-accent underline" to="/admin">
            {t('settings.adminLink')}
          </Link>
        </p>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / 1024 ** 2))} MB`;
}

function PlanSection() {
  const { t, lang } = useI18n();
  const plan = useQuery({ queryKey: ['plan'], queryFn: () => api<PlanDto>('/me/plan') });
  if (!plan.data) return null;
  const p = plan.data;
  const pct = p.aiMonthlyChars ? Math.min(100, Math.round((p.aiUsedChars / p.aiMonthlyChars) * 100)) : 0;
  return (
    <section className="card mt-4 max-w-5xl p-4" aria-labelledby="plan-h">
      <h2 id="plan-h" className="mb-2 font-medium">
        {t('plan.title')}: <span className="text-accent">{t(`plan.name.${p.plan}` as MessageKey)}</span>
      </h2>
      <ul className="space-y-1 text-sm text-muted">
        <li>{t('plan.priority', { n: p.priority })}</li>
        <li>{t('plan.pending', { n: p.pendingJobs, max: p.maxPendingJobs })}</li>
        <li>
          {t('plan.storage', { used: formatBytes(p.storageUsedBytes), limit: formatBytes(p.storageBytes) })}
        </li>
        <li>
          {p.aiMonthlyChars === null
            ? t('plan.aiUnlimited', { used: p.aiUsedChars.toLocaleString(lang) })
            : t('plan.ai', {
                used: p.aiUsedChars.toLocaleString(lang),
                limit: p.aiMonthlyChars.toLocaleString(lang),
              })}
        </li>
      </ul>
      <meter
        className="mt-2 h-2 w-full"
        min={0}
        max={p.storageBytes}
        value={Math.min(p.storageUsedBytes, p.storageBytes)}
        aria-label={t('plan.storageMeter')}
      />
      {p.aiMonthlyChars !== null && (
        <meter
          className="mt-2 h-2 w-full"
          min={0}
          max={p.aiMonthlyChars}
          value={Math.min(p.aiUsedChars, p.aiMonthlyChars)}
          aria-label={t('plan.aiMeter')}
          title={`${pct}%`}
        />
      )}
      <p className="mt-2 text-xs text-dim">{t('plan.noteAdmin')}</p>
    </section>
  );
}
