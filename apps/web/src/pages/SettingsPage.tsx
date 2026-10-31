import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAN_IDS, type AdminOverviewDto, type AdminWorkspaceDto, type PlanDto } from '@voxstudio/contracts';
import type { MessageKey } from '../i18n/en';
import { api, describeError } from '../api/client';
import { useAuth } from '../app/auth';
import { ModeSwitch } from '../app/Shell';
import { ErrorNote, LanguageSelect, Spinner, TierBadge, fmtBytes, fmtDate } from '../components/ui';
import { useI18n } from '../i18n';

export function SettingsPage() {
  const { user, reload } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState(user?.displayName ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
      <PlanSection />
      {user?.role === 'admin' ? (
        <AdminPanel />
      ) : (
        <p className="mt-6 text-sm text-muted">{t('settings.notAdmin')}</p>
      )}
    </div>
  );
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
          {p.aiMonthlyChars === null
            ? t('plan.aiUnlimited', { used: p.aiUsedChars.toLocaleString(lang) })
            : t('plan.ai', {
                used: p.aiUsedChars.toLocaleString(lang),
                limit: p.aiMonthlyChars.toLocaleString(lang),
              })}
        </li>
      </ul>
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

function AdminWorkspaces() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin-workspaces'],
    queryFn: () => api<AdminWorkspaceDto[]>('/admin/workspaces'),
  });
  const [err, setErr] = useState<string | null>(null);
  if (!q.data) return null;
  return (
    <div className="card overflow-x-auto p-4">
      <h3 className="mb-2 font-medium">{t('admin.plans')}</h3>
      {err && <p className="mb-2 text-sm text-danger">{err}</p>}
      <table className="w-full text-xs">
        <thead className="text-left text-dim">
          <tr>
            <th className="py-1">{t('dash.col.name')}</th>
            <th>{t('admin.col.owner')}</th>
            <th>{t('admin.col.plan')}</th>
            <th>{t('admin.col.aiUsed')}</th>
            <th>{t('admin.col.pending')}</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((w) => (
            <tr key={w.id} className="border-t border-line">
              <td className="py-1">{w.name}</td>
              <td>{w.ownerEmail}</td>
              <td>
                <select
                  className="input w-32 py-0.5 text-xs"
                  value={w.plan}
                  aria-label={t('admin.setPlan', { name: w.name })}
                  onChange={(e) => {
                    setErr(null);
                    api(`/admin/workspaces/${w.id}/plan`, { method: 'PATCH', body: { plan: e.target.value } })
                      .then(() => qc.invalidateQueries({ queryKey: ['admin-workspaces'] }))
                      .catch((x) => setErr(describeError(x)));
                  }}
                >
                  {PLAN_IDS.map((id) => (
                    <option key={id} value={id}>
                      {t(`plan.name.${id}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="font-mono">{w.aiUsedChars.toLocaleString(lang)}</td>
              <td className="font-mono">{w.pendingJobs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminPanel() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const ov = useQuery({
    queryKey: ['admin'],
    queryFn: () => api<AdminOverviewDto>('/admin/overview'),
    refetchInterval: 15_000,
  });
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['admin'] });
      await qc.invalidateQueries({ queryKey: ['voices'] });
    } catch (e) {
      setError(describeError(e));
    }
  };
  if (ov.isLoading)
    return (
      <div className="mt-6">
        <Spinner label={t('admin.loading')} />
      </div>
    );
  if (ov.error || !ov.data)
    return (
      <div className="mt-6">
        <ErrorNote error={ov.error ?? '—'} />
      </div>
    );
  const d = ov.data;
  return (
    <section className="mt-8 space-y-4" aria-labelledby="admin-h">
      <h2 id="admin-h" className="text-base font-semibold">
        {t('admin.title')}
      </h2>
      {error && <ErrorNote error={error} />}
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label={t('admin.queued')} value={d.jobs.queued} />
        <Stat label={t('admin.running')} value={d.jobs.running} />
        <Stat label={t('admin.succeeded')} value={d.jobs.succeeded24h} />
        <Stat label={t('admin.failed')} value={d.jobs.failed24h} />
        <Stat
          label={t('admin.assets')}
          value={`${d.storage.assetCount} · ${fmtBytes(d.storage.totalBytes, lang)}`}
        />
        <Stat
          label={t('admin.heartbeat')}
          value={d.worker.lastHeartbeatAt ? fmtDate(d.worker.lastHeartbeatAt, lang) : '—'}
        />
        <Stat label={t('admin.workerEspeak')} value={d.worker.espeakVersion ?? '—'} />
        <Stat label={t('admin.workerFfmpeg')} value={d.worker.ffmpegVersion ?? '—'} />
      </div>
      <div className="card p-4">
        <h3 className="mb-2 font-medium">{t('admin.engines')}</h3>
        {d.engines.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">
              {e.displayName} {e.version}
            </span>
            <span className="badge bg-ok/15 text-ok">{e.complianceStatus}</span>
            <span className="text-xs text-muted">{e.synthesisMethod}</span>
            <span className={`text-xs ${e.health?.ok ? 'text-ok' : 'text-danger'}`}>{e.health?.detail}</span>
            <label className="ml-auto flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={e.enabled}
                onChange={(ev) =>
                  void act(() =>
                    api(`/admin/engines/${e.id}`, { method: 'PATCH', body: { enabled: ev.target.checked } }),
                  )
                }
              />{' '}
              {t('common.enabled')}
            </label>
          </div>
        ))}
      </div>
      <div className="card overflow-x-auto p-4">
        <div className="mb-2 flex items-center">
          <h3 className="font-medium">{t('admin.voices')}</h3>
          <button
            className="btn btn-sm ml-auto"
            onClick={() => void act(() => api('/admin/catalog/refresh', { method: 'POST' }))}
          >
            {t('admin.reload')}
          </button>
        </div>
        <table className="w-full text-xs">
          <thead className="text-left text-dim">
            <tr>
              <th className="py-1">{t('admin.col.voice')}</th>
              <th>{t('admin.col.locale')}</th>
              <th>{t('admin.col.installed')}</th>
              <th>QA</th>
              <th>{t('admin.col.tier')}</th>
              <th>{t('admin.col.notes')}</th>
              <th>{t('admin.col.enabled')}</th>
            </tr>
          </thead>
          <tbody>
            {d.voices.map((v) => (
              <tr key={v.id} className="border-t border-line">
                <td className="py-1.5">{v.displayName}</td>
                <td className="font-mono text-muted">{v.locale}</td>
                <td>{v.installed ? t('common.yes') : t('common.no')}</td>
                <td className={v.qaStatus === 'passed' ? 'text-ok' : 'text-danger'}>{v.qaStatus}</td>
                <td>
                  <TierBadge tier={v.supportTier} />
                </td>
                <td className="max-w-md truncate text-muted" title={v.qaNotes}>
                  {v.qaNotes}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t('admin.enableVoice', { name: v.displayName })}
                    checked={v.enabled}
                    disabled={v.qaStatus !== 'passed' || !v.installed}
                    onChange={(ev) =>
                      void act(() =>
                        api(`/admin/voices/${encodeURIComponent(v.id)}`, {
                          method: 'PATCH',
                          body: { enabled: ev.target.checked },
                        }),
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AdminWorkspaces />
      <div className="card p-4">
        <h3 className="mb-2 font-medium">{t('admin.failures')}</h3>
        {d.recentFailures.length === 0 ? (
          <p className="text-sm text-muted">{t('common.none')}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {d.recentFailures.map((f) => (
              <li key={f.id}>
                <span className="font-mono text-danger">{f.errorCode}</span> {f.errorMessage}{' '}
                <span className="text-dim">{f.completedAt && fmtDate(f.completedAt, lang)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-sm">{value}</p>
    </div>
  );
}
