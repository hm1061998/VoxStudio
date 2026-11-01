import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PLAN_IDS,
  type AdminAuditDto,
  type AdminOrderDto,
  type AdminPaymentEventDto,
  type AdminOverviewDto,
  type AdminUserDto,
  type AdminUserPageDto,
  type AdminWorkspaceDto,
  type PlanId,
} from '@voxstudio/contracts';
import { api, describeError } from '../api/client';
import { useAuth } from '../app/auth';
import { AiBadge } from '../components/VoiceProfilePanel';
import { Confirm, ErrorNote, Spinner, TierBadge, fmtBytes, fmtDate } from '../components/ui';
import { StatusBadge, useVnd } from './UpgradePage';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';

const TABS = ['overview', 'users', 'plans', 'orders', 'voices', 'audit'] as const;
type Tab = (typeof TABS)[number];

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
  hint?: string;
}) {
  const color =
    tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-danger' : '';
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-dim">{hint}</p>}
    </div>
  );
}

/** Administrator dashboard. The server enforces the role on every route; this page is only the front door. */
export function AdminPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  if (user?.role !== 'admin')
    return (
      <div className="p-6" role="alert">
        <h1 className="mb-2 text-lg font-semibold">{t('adm.forbiddenTitle')}</h1>
        <p className="text-sm text-muted">{t('adm.forbidden')}</p>
      </div>
    );
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const n = TABS[(next + TABS.length) % TABS.length]!;
    setTab(n);
    document.getElementById(`adm-tab-${n}`)?.focus();
  };
  return (
    <div className="h-full overflow-auto p-6 scroll-thin">
      <h1 className="mb-1 text-lg font-semibold">{t('adm.title')}</h1>
      <p className="mb-4 text-sm text-muted">{t('adm.intro')}</p>
      <div
        role="tablist"
        aria-label={t('adm.tabs')}
        className="mb-4 flex flex-wrap gap-1 border-b border-line"
        onKeyDown={onKey}
      >
        {TABS.map((id) => (
          <button
            key={id}
            id={`adm-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls="adm-panel"
            tabIndex={tab === id ? 0 : -1}
            className={`px-3 py-2 text-sm font-medium ${tab === id ? 'border-b-2 border-accent text-fg' : 'text-muted hover:text-fg'}`}
            onClick={() => setTab(id)}
          >
            {t(`adm.tab.${id}` as MessageKey)}
          </button>
        ))}
      </div>
      <div id="adm-panel" role="tabpanel" aria-labelledby={`adm-tab-${tab}`}>
        {tab === 'overview' && <Overview />}
        {tab === 'users' && <Users />}
        {tab === 'plans' && <Plans />}
        {tab === 'orders' && <Orders />}
        {tab === 'voices' && <VoicesAndEngines />}
        {tab === 'audit' && <Audit />}
      </div>
    </div>
  );
}

const useOverview = () =>
  useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api<AdminOverviewDto>('/admin/overview'),
    refetchInterval: 15_000,
  });

function Overview() {
  const { t, lang } = useI18n();
  const ov = useOverview();
  if (ov.isLoading) return <Spinner label={t('admin.loading')} />;
  if (ov.error || !ov.data) return <ErrorNote error={ov.error ?? '—'} />;
  const d = ov.data;
  const ai = d.ai;
  return (
    <div className="space-y-4">
      <section aria-labelledby="adm-ov-users">
        <h2 id="adm-ov-users" className="mb-2 text-sm font-semibold text-muted">
          {t('adm.ov.users')}
        </h2>
        <div className="grid gap-3 md:grid-cols-5">
          <Stat label={t('adm.ov.total')} value={d.users.total} />
          <Stat label={t('adm.ov.active')} value={d.users.active} tone="ok" />
          <Stat
            label={t('adm.ov.suspended')}
            value={d.users.suspended}
            tone={d.users.suspended ? 'warn' : undefined}
          />
          <Stat label={t('adm.ov.admins')} value={d.users.admins} />
          <Stat label={t('adm.ov.new7')} value={d.users.newLast7Days} />
        </div>
      </section>
      {d.disk.state !== 'ok' && (
        <div
          role="alert"
          className={`card p-3 text-sm ${d.disk.state === 'block' ? 'border-danger text-danger' : 'border-warn text-warn'}`}
        >
          {t(d.disk.state === 'block' ? 'adm.disk.blockMsg' : 'adm.disk.warnMsg', {
            free: fmtBytes(d.disk.freeBytes, lang),
            total: fmtBytes(d.disk.totalBytes, lang),
          })}
        </div>
      )}
      <section aria-labelledby="adm-ov-sys">
        <h2 id="adm-ov-sys" className="mb-2 text-sm font-semibold text-muted">
          {t('adm.ov.system')}
        </h2>
        <div className="grid gap-3 md:grid-cols-4">
          <Stat
            label={t('adm.ov.aiService')}
            value={ai.enabled ? (ai.service?.ok ? t('adm.ov.up') : t('adm.ov.down')) : t('adm.ov.off')}
            tone={ai.enabled ? (ai.service?.ok ? 'ok' : 'bad') : undefined}
            hint={ai.service?.detail}
          />
          <Stat
            label={t('adm.ov.aiUsed', { month: ai.month })}
            value={ai.usedCharsThisMonth.toLocaleString(lang)}
            hint={t('adm.ov.chars')}
          />
          <Stat
            label={t('admin.queued')}
            value={d.jobs.queued}
            tone={d.jobs.queued > 20 ? 'warn' : undefined}
          />
          <Stat label={t('admin.running')} value={d.jobs.running} />
          <Stat label={t('admin.succeeded')} value={d.jobs.succeeded24h} />
          <Stat
            label={t('admin.failed')}
            value={d.jobs.failed24h}
            tone={d.jobs.failed24h ? 'warn' : undefined}
          />
          <Stat
            label={t('admin.assets')}
            value={`${d.storage.assetCount} · ${fmtBytes(d.storage.totalBytes, lang)}`}
          />
          <Stat
            label={t('adm.disk.free')}
            value={`${fmtBytes(d.disk.freeBytes, lang)} / ${fmtBytes(d.disk.totalBytes, lang)}`}
            tone={d.disk.state === 'ok' ? 'ok' : d.disk.state === 'warn' ? 'warn' : 'bad'}
            hint={t(`adm.disk.state.${d.disk.state}` as MessageKey)}
          />
          <Stat
            label={t('admin.heartbeat')}
            value={d.worker.lastHeartbeatAt ? fmtDate(d.worker.lastHeartbeatAt, lang) : '—'}
            tone={d.worker.lastHeartbeatAt ? undefined : 'bad'}
          />
        </div>
      </section>
      {d.topWorkspaces.length > 0 && (
        <section aria-labelledby="adm-ov-top">
          <h2 id="adm-ov-top" className="mb-2 text-sm font-semibold text-muted">
            {t('adm.disk.top')}
          </h2>
          <ul className="card divide-y divide-line text-sm">
            {d.topWorkspaces.map((w) => (
              <li key={w.workspaceId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate">
                  {w.name} <span className="text-dim">· {t(`plan.name.${w.plan}` as MessageKey)}</span>
                </span>
                <span className="tabular-nums">{fmtBytes(w.bytes, lang)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="adm-ov-sec">
        <h2 id="adm-ov-sec" className="mb-2 text-sm font-semibold text-muted">
          {t('adm.ov.security')}
        </h2>
        <div className="grid gap-3 md:grid-cols-4">
          <Stat
            label={t('adm.ov.failedSignIns')}
            value={d.security.failedSignIns24h}
            tone={d.security.failedSignIns24h > 50 ? 'warn' : undefined}
          />
          <Stat
            label={t('adm.ov.locked')}
            value={d.security.lockedNow}
            tone={d.security.lockedNow ? 'warn' : undefined}
          />
          <Stat label={t('adm.ov.sessions')} value={d.security.activeSessions} />
          <Stat
            label={t('adm.ov.registration')}
            value={d.security.registrationOpen ? t('adm.ov.open') : t('adm.ov.closed')}
            hint={t('adm.ov.registrationHint')}
          />
        </div>
      </section>
      <section aria-labelledby="adm-ov-plans">
        <h2 id="adm-ov-plans" className="mb-2 text-sm font-semibold text-muted">
          {t('adm.ov.plans')}
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          {PLAN_IDS.map((p) => (
            <Stat key={p} label={t(`plan.name.${p}` as MessageKey)} value={d.plans[p]} />
          ))}
        </div>
      </section>
      <section className="card p-4" aria-labelledby="adm-ov-fail">
        <h2 id="adm-ov-fail" className="mb-2 font-medium">
          {t('admin.failures')}
        </h2>
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
      </section>
    </div>
  );
}

type Pending = { user: AdminUserDto; action: 'promote' | 'demote' | 'suspend' | 'activate' | 'revoke' };

function Users() {
  const { t, lang } = useI18n();
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      setTerm(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [q]);
  const list = useQuery({
    queryKey: ['admin', 'users', term, page],
    queryFn: () =>
      api<AdminUserPageDto>(
        `/admin/users?page=${page}&pageSize=20${term ? `&q=${encodeURIComponent(term)}` : ''}`,
      ),
  });
  const run = async (p: Pending) => {
    setError(null);
    try {
      if (p.action === 'revoke') await api(`/admin/users/${p.user.id}/revoke-sessions`, { method: 'POST' });
      else
        await api(`/admin/users/${p.user.id}`, {
          method: 'PATCH',
          body:
            p.action === 'promote'
              ? { role: 'admin' }
              : p.action === 'demote'
                ? { role: 'user' }
                : { status: p.action === 'suspend' ? 'suspended' : 'active' },
        });
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setPending(null);
    }
  };
  const d = list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <section aria-labelledby="adm-users-h" className="space-y-3">
      <h2 id="adm-users-h" className="sr-only">
        {t('adm.tab.users')}
      </h2>
      <div>
        <label className="label" htmlFor="adm-user-q">
          {t('adm.users.search')}
        </label>
        <input
          id="adm-user-q"
          className="input max-w-sm"
          value={q}
          maxLength={100}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error && <ErrorNote error={error} />}
      {list.isLoading && <Spinner />}
      {list.error && <ErrorNote error={list.error} />}
      {d && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('adm.tab.users')}</caption>
            <thead className="border-b border-line bg-panel-2 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.users.user')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.users.role')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.users.status')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('admin.col.plan')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('admin.col.aiUsed')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.users.projects')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.users.lastLogin')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.users.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((u) => {
                const self = u.id === me?.id;
                const btn = (action: Pending['action'], label: MessageKey, danger?: boolean) => (
                  <button
                    key={action}
                    className={`btn btn-sm ${danger ? 'text-danger' : ''}`}
                    disabled={self}
                    title={self ? t('adm.users.self') : undefined}
                    aria-label={t(label) + ': ' + u.email}
                    onClick={() => setPending({ user: u, action })}
                  >
                    {t(label)}
                  </button>
                );
                return (
                  <tr key={u.id} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{u.displayName}</div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`badge ${u.role === 'admin' ? 'bg-accent/15 text-accent' : 'bg-line text-muted'}`}
                      >
                        {t(`adm.role.${u.role}` as MessageKey)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`badge ${u.status === 'active' ? 'bg-ok/15 text-ok' : 'bg-danger/15 text-danger'}`}
                      >
                        {t(`adm.status.${u.status}` as MessageKey)}
                      </span>
                      <div className="mt-0.5 text-[11px] text-dim">
                        {t('adm.users.sessions', { n: u.activeSessions })}
                      </div>
                    </td>
                    <td className="px-3 py-2">{t(`plan.name.${u.plan}` as MessageKey)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{u.aiUsedChars.toLocaleString(lang)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{u.projects}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {u.lastLoginAt ? fmtDate(u.lastLoginAt, lang) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {u.role === 'admin'
                          ? btn('demote', 'adm.act.demote')
                          : btn('promote', 'adm.act.promote')}
                        {u.status === 'active'
                          ? btn('suspend', 'adm.act.suspend', true)
                          : btn('activate', 'adm.act.activate')}
                        <button
                          className="btn btn-sm"
                          aria-label={t('adm.act.revoke') + ': ' + u.email}
                          onClick={() => setPending({ user: u, action: 'revoke' })}
                        >
                          {t('adm.act.revoke')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {d.items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted">
                    {t('adm.users.none')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {d && (
        <div className="flex items-center gap-3 text-sm text-muted">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('adm.prev')}
          </button>
          <span aria-live="polite">{t('adm.page', { page, pages, total: d.total })}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            {t('adm.next')}
          </button>
        </div>
      )}
      {pending && (
        <Confirm
          title={t(`adm.confirm.${pending.action}.title` as MessageKey)}
          message={t(`adm.confirm.${pending.action}.msg` as MessageKey, { email: pending.user.email })}
          confirmLabel={t(`adm.act.${pending.action}` as MessageKey)}
          danger={pending.action === 'suspend' || pending.action === 'demote' || pending.action === 'revoke'}
          onClose={() => setPending(null)}
          onConfirm={() => void run(pending)}
        />
      )}
    </section>
  );
}

function Plans() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: () => api<AdminWorkspaceDto[]>('/admin/workspaces'),
  });
  const [err, setErr] = useState<string | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? '—'} />;
  return (
    <section className="card overflow-x-auto p-4" aria-labelledby="adm-plans-h">
      <h2 id="adm-plans-h" className="mb-1 font-medium">
        {t('admin.plans')}
      </h2>
      <p className="mb-3 text-xs text-dim">{t('plan.noteAdmin')}</p>
      {err && <ErrorNote error={err} />}
      <table className="w-full text-sm">
        <caption className="sr-only">{t('admin.plans')}</caption>
        <thead className="text-left text-xs text-dim">
          <tr>
            <th scope="col" className="py-1">
              {t('dash.col.name')}
            </th>
            <th scope="col">{t('admin.col.owner')}</th>
            <th scope="col">{t('admin.col.plan')}</th>
            <th scope="col">{t('admin.col.expires')}</th>
            <th scope="col">{t('admin.col.aiUsed')}</th>
            <th scope="col">{t('admin.col.pending')}</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((w) => (
            <tr key={w.id} className="border-t border-line">
              <td className="py-1.5">{w.name}</td>
              <td>{w.ownerEmail}</td>
              <td>
                <select
                  className="input w-36 py-0.5 text-xs"
                  value={w.plan}
                  aria-label={t('admin.setPlan', { name: w.name })}
                  onChange={(e) => {
                    setErr(null);
                    api(`/admin/workspaces/${w.id}/plan`, {
                      method: 'PATCH',
                      body: { plan: e.target.value as PlanId },
                    })
                      .then(() => qc.invalidateQueries({ queryKey: ['admin'] }))
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
              <td>
                <input
                  type="date"
                  className="input w-40 py-0.5 text-xs"
                  disabled={w.plan === 'free'}
                  value={w.planExpiresAt?.slice(0, 10) ?? ''}
                  aria-label={t('admin.setExpiry', { name: w.name })}
                  onChange={(e) => {
                    setErr(null);
                    api(`/admin/workspaces/${w.id}/plan`, {
                      method: 'PATCH',
                      body: {
                        plan: w.plan,
                        expiresAt: e.target.value ? `${e.target.value}T23:59:59.000Z` : null,
                      },
                    })
                      .then(() => qc.invalidateQueries({ queryKey: ['admin'] }))
                      .catch((x) => setErr(describeError(x)));
                  }}
                />
              </td>
              <td className="font-mono text-xs">{w.aiUsedChars.toLocaleString(lang)}</td>
              <td className="font-mono text-xs">{w.pendingJobs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Orders() {
  const { t, lang } = useI18n();
  const vnd = useVnd();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ order: AdminOrderDto; action: 'confirm' | 'reject' } | null>(null);
  const orders = useQuery({
    queryKey: ['admin', 'orders', status],
    queryFn: () => api<AdminOrderDto[]>(`/admin/orders${status ? `?status=${status}` : ''}`),
    refetchInterval: 20_000,
  });
  const events = useQuery({
    queryKey: ['admin', 'payment-events'],
    queryFn: () => api<AdminPaymentEventDto[]>('/admin/payment-events'),
  });
  const decide = async (o: AdminOrderDto, action: 'confirm' | 'reject') => {
    setErr(null);
    try {
      await api(`/admin/orders/${o.id}/${action}`, { method: 'POST', body: {} });
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      setErr(describeError(e));
    }
  };
  if (orders.isLoading) return <Spinner />;
  if (orders.error || !orders.data) return <ErrorNote error={orders.error ?? '—'} />;
  return (
    <div className="space-y-4">
      <section className="card overflow-x-auto p-4" aria-labelledby="adm-orders-h">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="adm-orders-h" className="font-medium">
            {t('adm.orders')}
          </h2>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">{t('adm.orders.filter')}</span>
            <select
              className="input w-40 py-1 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">{t('create.any')}</option>
              {['pending', 'review', 'paid', 'expired', 'cancelled'].map((s) => (
                <option key={s} value={s}>
                  {t(`order.status.${s}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mb-3 text-xs text-dim">{t('adm.orders.hint')}</p>
        {err && <ErrorNote error={err} />}
        {orders.data.length === 0 ? (
          <p className="text-sm text-muted">{t('adm.orders.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t('adm.orders')}</caption>
            <thead className="text-left text-xs text-dim">
              <tr>
                <th scope="col">{t('upgrade.col.date')}</th>
                <th scope="col">{t('admin.col.owner')}</th>
                <th scope="col">{t('upgrade.col.plan')}</th>
                <th scope="col">{t('upgrade.amount')}</th>
                <th scope="col">{t('upgrade.note')}</th>
                <th scope="col">{t('upgrade.col.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('dash.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id} className="border-t border-line align-top">
                  <td className="py-1.5">{fmtDate(o.createdAt, lang)}</td>
                  <td>
                    {o.ownerEmail}
                    <span className="block text-xs text-dim">{o.workspaceName}</span>
                  </td>
                  <td>
                    {t(`plan.name.${o.plan}` as MessageKey)} · {o.months}
                  </td>
                  <td className="font-mono text-xs">
                    {vnd(o.amountVnd)}
                    {o.paidAmountVnd !== null && o.paidAmountVnd !== o.amountVnd && (
                      <span className="block text-warn">
                        {t('adm.orders.received', { amount: vnd(o.paidAmountVnd) })}
                      </span>
                    )}
                  </td>
                  <td className="font-mono text-xs">{o.paymentCode}</td>
                  <td>
                    <StatusBadge status={o.status} />
                    {o.note && <span className="mt-1 block text-xs text-muted">{o.note}</span>}
                  </td>
                  <td>
                    {o.status !== 'paid' && o.status !== 'cancelled' && (
                      <div className="flex gap-1">
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => setAsking({ order: o, action: 'confirm' })}
                        >
                          {t('adm.orders.confirm')}
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => setAsking({ order: o, action: 'reject' })}
                        >
                          {t('adm.orders.reject')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {(events.data ?? []).length > 0 && (
        <section className="card overflow-x-auto p-4" aria-labelledby="adm-events-h">
          <h2 id="adm-events-h" className="mb-1 font-medium">
            {t('adm.events')}
          </h2>
          <p className="mb-3 text-xs text-dim">{t('adm.events.hint')}</p>
          <table className="w-full text-sm">
            <caption className="sr-only">{t('adm.events')}</caption>
            <thead className="text-left text-xs text-dim">
              <tr>
                <th scope="col">{t('upgrade.col.date')}</th>
                <th scope="col">{t('upgrade.amount')}</th>
                <th scope="col">{t('adm.events.note')}</th>
                <th scope="col">{t('upgrade.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {(events.data ?? []).map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="py-1.5">{fmtDate(e.createdAt, lang)}</td>
                  <td className="font-mono text-xs">{vnd(e.amountVnd)}</td>
                  <td className="max-w-xs truncate">{e.note}</td>
                  <td>{t(`adm.events.${e.result}` as MessageKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {asking && (
        <Confirm
          danger={asking.action === 'reject'}
          title={t(asking.action === 'confirm' ? 'adm.orders.confirmTitle' : 'adm.orders.rejectTitle')}
          message={t(asking.action === 'confirm' ? 'adm.orders.confirmMsg' : 'adm.orders.rejectMsg', {
            code: asking.order.paymentCode,
            amount: vnd(asking.order.amountVnd),
          })}
          confirmLabel={t(asking.action === 'confirm' ? 'adm.orders.confirm' : 'adm.orders.reject')}
          onClose={() => setAsking(null)}
          onConfirm={() => void decide(asking.order, asking.action)}
        />
      )}
    </div>
  );
}

function VoicesAndEngines() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const ov = useOverview();
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
  if (ov.isLoading) return <Spinner />;
  if (ov.error || !ov.data) return <ErrorNote error={ov.error ?? '—'} />;
  const d = ov.data;
  return (
    <div className="space-y-4">
      {error && <ErrorNote error={error} />}
      <section className="card p-4" aria-labelledby="adm-eng-h">
        <h2 id="adm-eng-h" className="mb-2 font-medium">
          {t('admin.engines')}
        </h2>
        {d.engines.map((e) => (
          <div
            key={e.id}
            className="flex flex-wrap items-center gap-3 border-t border-line py-2 text-sm first:border-t-0"
          >
            <span className="font-medium">
              {e.displayName} {e.version}
            </span>
            <AiBadge usesAi={e.usesAi} />
            <span
              className={`badge ${e.complianceStatus === 'approved' ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`}
            >
              {e.complianceStatus}
            </span>
            <span className="text-xs text-muted">{e.synthesisMethod}</span>
            <span className={`text-xs ${e.health?.ok ? 'text-ok' : 'text-danger'}`}>{e.health?.detail}</span>
            <label className="ml-auto flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={e.enabled}
                disabled={e.complianceStatus !== 'approved'}
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
      </section>
      <section className="card overflow-x-auto p-4" aria-labelledby="adm-voices-h">
        <div className="mb-2 flex items-center">
          <h2 id="adm-voices-h" className="font-medium">
            {t('admin.voices')}
          </h2>
          <button
            className="btn btn-sm ml-auto"
            onClick={() => void act(() => api('/admin/catalog/refresh', { method: 'POST' }))}
          >
            {t('admin.reload')}
          </button>
        </div>
        <table className="w-full text-xs">
          <caption className="sr-only">{t('admin.voices')}</caption>
          <thead className="text-left text-dim">
            <tr>
              <th scope="col" className="py-1">
                {t('admin.col.voice')}
              </th>
              <th scope="col">{t('admin.col.locale')}</th>
              <th scope="col">{t('adm.voices.gender')}</th>
              <th scope="col">{t('admin.col.tier')}</th>
              <th scope="col">{t('admin.col.notes')}</th>
              <th scope="col">{t('admin.col.enabled')}</th>
            </tr>
          </thead>
          <tbody>
            {d.voices.map((v) => (
              <tr key={v.id} className="border-t border-line">
                <td className="py-1.5">
                  {v.displayName} <AiBadge usesAi={v.usesAi} />
                </td>
                <td className="font-mono">{v.locale}</td>
                <td>{v.gender ? t(`profile.gender.${v.gender}` as MessageKey) : '—'}</td>
                <td>
                  <TierBadge tier={v.supportTier} />
                </td>
                <td className="max-w-xs text-dim">{v.qaNotes}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={v.enabled}
                    disabled={v.qaStatus !== 'passed'}
                    aria-label={t('admin.enableVoice', { name: v.displayName })}
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
      </section>
    </div>
  );
}

const AUDIT_FILTERS = ['', 'auth.', 'admin.', 'workspace.', 'project.'] as const;

function Audit() {
  const { t, lang } = useI18n();
  const [prefix, setPrefix] = useState<string>('');
  const q = useQuery({
    queryKey: ['admin', 'audit', prefix],
    queryFn: () =>
      api<AdminAuditDto[]>(`/admin/audit?limit=100${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`),
    refetchInterval: 20_000,
  });
  return (
    <section aria-labelledby="adm-audit-h" className="space-y-3">
      <div className="flex items-end gap-3">
        <h2 id="adm-audit-h" className="font-medium">
          {t('adm.audit.title')}
        </h2>
        <div className="ml-auto">
          <label className="label" htmlFor="adm-audit-f">
            {t('adm.audit.filter')}
          </label>
          <select
            id="adm-audit-f"
            className="input w-44"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          >
            {AUDIT_FILTERS.map((f) => (
              <option key={f} value={f}>
                {f ? f : t('adm.audit.all')}
              </option>
            ))}
          </select>
        </div>
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorNote error={q.error} />}
      {q.data && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">{t('adm.audit.title')}</caption>
            <thead className="border-b border-line bg-panel-2 text-left text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.audit.time')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.audit.event')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.audit.actor')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('adm.audit.details')}
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((e) => (
                <tr key={e.id} className="border-b border-line align-top last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted">{fmtDate(e.createdAt, lang)}</td>
                  <td className="px-3 py-1.5 font-mono">{e.eventType}</td>
                  <td className="px-3 py-1.5">{e.actorEmail ?? '—'}</td>
                  <td className="max-w-md break-words px-3 py-1.5 font-mono text-[11px] text-dim">
                    {e.resourceType}:{e.resourceId.slice(0, 8)}{' '}
                    {Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : ''}
                  </td>
                </tr>
              ))}
              {q.data.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted">
                    {t('common.none')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
