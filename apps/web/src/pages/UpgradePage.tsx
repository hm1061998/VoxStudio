import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingInfoDto, OrderDto, OrderStatus } from '@voxstudio/contracts';
import type { MessageKey } from '../i18n/en';
import { api, describeError } from '../api/client';
import { ErrorNote, Spinner, fmtDate } from '../components/ui';
import { useI18n } from '../i18n';

const PAID = ['pro', 'business'] as const;
const STATUS_TONE: Record<OrderStatus, string> = {
  pending: 'bg-warn/15 text-warn',
  paid: 'bg-ok/15 text-ok',
  review: 'bg-warn/15 text-warn',
  cancelled: 'bg-panel-2 text-muted',
  expired: 'bg-panel-2 text-muted',
};

export const useVnd = () => {
  const { lang } = useI18n();
  return (n: number) => `${n.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US')} ₫`;
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { t } = useI18n();
  return <span className={`badge ${STATUS_TONE[status]}`}>{t(`order.status.${status}` as MessageKey)}</span>;
}

/** Pay by bank transfer: pick a plan and a period, get an order with the code to write in the transfer note. */
export function UpgradeSection() {
  const { t, lang } = useI18n();
  const vnd = useVnd();
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['billing', 'info'],
    queryFn: () => api<BillingInfoDto>('/billing/info'),
  });
  const orders = useQuery({
    queryKey: ['billing', 'orders'],
    queryFn: () => api<OrderDto[]>('/billing/orders'),
  });
  const [plan, setPlan] = useState<(typeof PAID)[number]>('pro');
  const [months, setMonths] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing'] });
  const create = useMutation({
    mutationFn: () => api<OrderDto>('/billing/orders', { method: 'POST', body: { plan, months } }),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (e) => setError(describeError(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api<OrderDto>(`/billing/orders/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => void refresh(),
    onError: (e) => setError(describeError(e)),
  });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable: the text stays selectable */
    }
  };
  if (info.isLoading || orders.isLoading) return <Spinner />;
  if (info.error || !info.data) return <ErrorNote error={info.error ?? '—'} />;
  const b = info.data;
  if (!b.enabled)
    return (
      <section className="card max-w-xl space-y-2 p-5" aria-labelledby="up-h">
        <h2 id="up-h" className="text-lg font-semibold">
          {t('acct.upgrade')}
        </h2>
        <p className="text-muted">{t('upgrade.off')}</p>
      </section>
    );
  const price = b.prices[plan];
  const open = (orders.data ?? []).filter((o) => o.status === 'pending' || o.status === 'review');
  return (
    <>
      <section className="card max-w-xl space-y-4 p-5" aria-labelledby="up-h">
        <div>
          <h2 id="up-h" className="text-lg font-semibold">
            {t('acct.upgrade')}
          </h2>
          <p className="mt-1 text-sm text-muted">{t('upgrade.hint')}</p>
        </div>
        <fieldset>
          <legend className="label">{t('upgrade.choosePlan')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PAID.filter((p) => b.prices[p] !== undefined).map((p) => (
              <label
                key={p}
                className={`cursor-pointer rounded-[10px] border p-3 ${plan === p ? 'border-accent bg-accent/10' : 'border-line hover:border-accent'}`}
              >
                <input
                  type="radio"
                  name="plan"
                  className="mr-2"
                  checked={plan === p}
                  onChange={() => setPlan(p)}
                />
                <span className="font-semibold">{t(`plan.name.${p}` as MessageKey)}</span>
                <span className="mt-1 block text-sm text-muted">
                  {t('upgrade.perMonth', { price: vnd(b.prices[p]!) })}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor="months">
            {t('upgrade.months')}
          </label>
          <select
            id="months"
            className="input w-48"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            {b.months.map((m) => (
              <option key={m} value={m}>
                {t('upgrade.monthsN', { n: m })}
              </option>
            ))}
          </select>
        </div>
        {price !== undefined && (
          <p className="text-lg font-semibold">
            {t('upgrade.total')}: <span className="font-mono">{vnd(price * months)}</span>
          </p>
        )}
        <button className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
          {t('upgrade.create')}
        </button>
        {error && <ErrorNote error={error} />}
      </section>

      {open.map((o) => (
        <section
          key={o.id}
          className="card max-w-xl space-y-3 p-5"
          aria-label={t('upgrade.orderAria', { code: o.paymentCode })}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">
              {t(`plan.name.${o.plan}` as MessageKey)} · {t('upgrade.monthsN', { n: o.months })}
            </h3>
            <StatusBadge status={o.status} />
          </div>
          {o.status === 'review' ? (
            <p className="text-sm text-warn">{t('upgrade.inReview')}</p>
          ) : (
            <>
              <p className="text-sm text-muted">{t('upgrade.transferHint')}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {b.bank && (
                  <>
                    <dt className="text-muted">{t('upgrade.bank')}</dt>
                    <dd className="font-medium">{b.bank.name}</dd>
                    <dt className="text-muted">{t('upgrade.account')}</dt>
                    <dd className="font-mono">{b.bank.account}</dd>
                    {b.bank.holder && (
                      <>
                        <dt className="text-muted">{t('upgrade.holder')}</dt>
                        <dd>{b.bank.holder}</dd>
                      </>
                    )}
                  </>
                )}
                <dt className="text-muted">{t('upgrade.amount')}</dt>
                <dd className="font-mono font-semibold">{vnd(o.amountVnd)}</dd>
                <dt className="text-muted">{t('upgrade.note')}</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <code className="select-all rounded bg-panel-2 px-2 py-1 font-mono text-base font-bold">
                    {o.paymentCode}
                  </code>
                  <button className="btn btn-sm" onClick={() => void copy(o.paymentCode)}>
                    {copied === o.paymentCode ? t('upgrade.copied') : t('upgrade.copy')}
                  </button>
                </dd>
              </dl>
              {!b.bank && <p className="text-sm text-warn">{t('upgrade.noBank')}</p>}
              <p className="text-xs text-dim">{b.autoConfirm ? t('upgrade.auto') : t('upgrade.manual')}</p>
              <button className="btn btn-sm" disabled={cancel.isPending} onClick={() => cancel.mutate(o.id)}>
                {t('upgrade.cancel')}
              </button>
            </>
          )}
        </section>
      ))}

      {(orders.data ?? []).length > 0 && (
        <section className="card max-w-xl overflow-x-auto p-5" aria-labelledby="oh-h">
          <h3 id="oh-h" className="mb-2 font-semibold">
            {t('upgrade.history')}
          </h3>
          <table className="w-full text-sm">
            <caption className="sr-only">{t('upgrade.history')}</caption>
            <thead className="text-left text-xs text-dim">
              <tr>
                <th scope="col">{t('upgrade.col.date')}</th>
                <th scope="col">{t('upgrade.col.plan')}</th>
                <th scope="col">{t('upgrade.amount')}</th>
                <th scope="col">{t('upgrade.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {(orders.data ?? []).map((o) => (
                <tr key={o.id} className="border-t border-line">
                  <td className="py-1.5">{fmtDate(o.createdAt, lang)}</td>
                  <td>
                    {t(`plan.name.${o.plan}` as MessageKey)} · {o.months}
                  </td>
                  <td className="font-mono">{vnd(o.amountVnd)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
