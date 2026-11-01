import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { JobStatus, SegmentAudioState, SupportTier } from '@voxstudio/contracts';
import { useI18n } from '../i18n';

export { fmtBytes, fmtDate, fmtMs } from '../i18n';

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
      />
      <span className="text-xs">{label ?? t('common.loading')}…</span>
    </span>
  );
}

/**
 * Shown while a job is being made: moving bars, the seconds so far, and after a few seconds an honest note that the
 * wait is the queue or the AI model, with a way to leave and come back (the file lands in the exported-files list).
 */
export function Waiting({ label, className = '' }: { label: string; className?: string }) {
  const { t } = useI18n();
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-muted ${className}`}>
      <span aria-hidden className="wave">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />
        ))}
      </span>
      <span className="text-xs">
        {label.replace(/…$/, '')}… {secs > 0 && <span className="font-mono">{secs}s</span>}
      </span>
      {secs >= 8 && <span className="text-xs text-dim">{t('wait.long')}</span>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      <span aria-hidden>⚠</span>
      <span className="flex-1">{msg}</span>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}

/** Modal dialog with initial focus, Escape to close, and a labelled heading. */
export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        className={`card max-h-[90vh] w-full overflow-auto p-5 shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="dlg-title" className="text-base font-semibold">
            {title}
          </h2>
          <button
            data-close
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label={t('common.closeDialog')}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
  danger,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="mb-5 text-sm text-muted">{message}</div>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

const JOB_STYLE: Record<JobStatus, string> = {
  queued: 'bg-line text-muted',
  running: 'bg-native/15 text-native',
  succeeded: 'bg-ok/15 text-ok',
  failed: 'bg-danger/15 text-danger',
  cancelled: 'bg-line text-dim',
};
export function JobBadge({ status }: { status: JobStatus }) {
  const { t } = useI18n();
  return <span className={`badge ${JOB_STYLE[status]}`}>{t(`job.${status}`)}</span>;
}

const AUDIO_STYLE: Record<SegmentAudioState, string> = {
  missing: 'text-dim',
  stale: 'text-warn',
  queued: 'text-muted',
  rendering: 'text-native',
  ready: 'text-ok',
  failed: 'text-danger',
};
export function AudioStateBadge({ state }: { state: SegmentAudioState }) {
  const { t } = useI18n();
  return <span className={`text-[11px] font-medium ${AUDIO_STYLE[state]}`}>{t(`audio.${state}`)}</span>;
}

export function TierBadge({ tier }: { tier: SupportTier }) {
  const { t } = useI18n();
  const cls =
    tier === 'verified'
      ? 'bg-ok/15 text-ok'
      : tier === 'experimental'
        ? 'bg-warn/15 text-warn'
        : 'bg-line text-dim';
  return <span className={`badge ${cls}`}>{t(`tier.${tier}`)}</span>;
}

export function SupportBadge({ support }: { support: 'native' | 'dsp' | 'unsupported' }) {
  const { t } = useI18n();
  if (support === 'native')
    return (
      <span className="badge bg-native/15 text-native" title={t('support.nativeTitle')}>
        {t('support.native')}
      </span>
    );
  if (support === 'dsp')
    return (
      <span className="badge bg-dsp/15 text-dsp" title={t('support.dspTitle')}>
        {t('support.dsp')}
      </span>
    );
  return <span className="badge bg-line text-dim">{t('support.unsupported')}</span>;
}

export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const { t } = useI18n();
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2" aria-label={label}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded bg-line"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-20 text-right font-mono text-[11px] text-muted">
        {t('progress.units', { done: value, total: max })}
      </span>
    </div>
  );
}

/** Language + mode switches, used in the top of the app and on sign-in pages. */
export function LanguageSelect({ compact }: { compact?: boolean }) {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <span aria-hidden>🌐</span>
      <span className={compact ? 'sr-only' : ''}>{t('lang.label')}</span>
      <select
        className="input w-auto py-1 text-xs"
        value={lang}
        aria-label={t('lang.label')}
        onChange={(e) => setLang(e.target.value as 'vi' | 'en')}
      >
        <option value="vi">Tiếng Việt</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
