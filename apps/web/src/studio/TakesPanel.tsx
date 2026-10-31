import { useMemo, useState } from 'react';
import { assetUrl } from '../api/client';
import { useVoices } from '../api/hooks';
import { engineLabel, labelFor } from '../components/VoiceProfilePanel';
import { fmtMs } from '../components/ui';
import { settingLabel, useI18n } from '../i18n';
import { applyVoiceSettings } from './actions';
import { diffSettings, diffTakes, isIdentical } from './takes';
import { useStudio, type Take } from './store';

/**
 * Every preview of the selected paragraph, kept for listening and comparison. The audio is the real
 * server asset of each preview; the engine shown is the one the server recorded when it made the audio.
 */
export function TakesPanel({ segmentId }: { segmentId: string }) {
  const { t, lang } = useI18n();
  const allTakes = useStudio((s) => s.takes);
  const seg = useStudio((s) => s.segments.find((x) => x.id === segmentId));
  const voices = useVoices();
  const takes = useMemo(() => allTakes.filter((x) => x.segmentId === segmentId), [allTakes, segmentId]);
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  if (!seg) return null;

  // Oldest preview is number 1.
  const number = (take: Take) =>
    allTakes.filter((x) => x.segmentId === segmentId).length - takes.indexOf(take);
  const voiceName = (id: string) => {
    const v = voices.data?.find((x) => x.id === id);
    return v ? labelFor(v, voices.data ?? [], lang) : id;
  };
  const pickedTakes = picked.map((id) => takes.find((x) => x.id === id)).filter((x): x is Take => !!x);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  const apply = (take: Take, all: boolean) => {
    const st = useStudio.getState();
    const ids = all ? st.segments.map((s) => s.id) : [segmentId];
    const r = applyVoiceSettings(take, ids);
    setMessage(
      [t('takes.applied', { n: r.applied }), r.skipped ? t('takes.skipped', { n: r.skipped }) : '']
        .filter(Boolean)
        .join(' '),
    );
  };

  return (
    <section aria-label={t('takes.title')} className="card max-h-72 shrink-0 overflow-auto p-3 scroll-thin">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('takes.title')}</h3>
      {takes.length === 0 && <p className="text-xs text-muted">{t('takes.empty')}</p>}
      {message && (
        <p role="status" className="mb-2 text-xs text-accent">
          {message}
        </p>
      )}
      {pickedTakes.length === 2 && (
        <Comparison a={pickedTakes[0]!} b={pickedTakes[1]!} number={number} voiceName={voiceName} />
      )}
      <ul className="space-y-2">
        {takes.map((take) => {
          const diff = diffSettings(seg.settings, take.settings).map((d) => settingLabel(d.key, undefined));
          if (seg.voiceId !== take.voiceId) diff.unshift(t('takes.voiceDiffers'));
          if (seg.sourceText !== take.text) diff.push(t('takes.textDiffers'));
          const n = number(take);
          return (
            <li key={take.id} className="rounded-md border border-line bg-panel-2 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex items-center gap-1.5 font-medium">
                  <input
                    type="checkbox"
                    checked={picked.includes(take.id)}
                    onChange={() => toggle(take.id)}
                    aria-label={t('takes.compareCheck', { n })}
                  />
                  {t('takes.take', { n })}
                </label>
                <span className="text-muted">{voiceName(take.voiceId)}</span>
                <span className="text-dim">
                  {take.engines.length
                    ? t('takes.engine', { engine: take.engines.map(engineLabel).join(', ') })
                    : t('takes.noEngine')}
                </span>
                <span className="ml-auto font-mono text-dim">{fmtMs(take.durationMs)}</span>
              </div>
              <p className="mt-1 text-dim">
                {diff.length ? t('takes.differs', { list: diff.join(', ') }) : t('takes.same')}
              </p>
              <audio
                controls
                preload="none"
                src={assetUrl(take.assetId)}
                className="mt-1 h-8 w-full"
                aria-label={t('takes.audioAria', { n })}
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                <button className="btn btn-sm" onClick={() => apply(take, false)}>
                  {t('takes.applyHere')}
                </button>
                <button className="btn btn-sm" onClick={() => apply(take, true)}>
                  {t('takes.applyAll')}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    useStudio.getState().removeTake(take.id);
                    setPicked((p) => p.filter((x) => x !== take.id));
                  }}
                >
                  {t('takes.remove')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Comparison({
  a,
  b,
  number,
  voiceName,
}: {
  a: Take;
  b: Take;
  number: (t: Take) => number;
  voiceName: (id: string) => string;
}) {
  const { t, lang } = useI18n();
  const d = diffTakes(a, b);
  const fmt = (v: unknown) => (typeof v === 'number' ? v.toLocaleString(lang) : String(v));
  return (
    <div className="mb-3 rounded-md border border-accent/40 p-2 text-xs" role="region" aria-label="compare">
      <p className="mb-1 font-medium">{t('takes.compareTitle', { a: number(a), b: number(b) })}</p>
      {isIdentical(d) ? (
        <p className="text-muted">{t('takes.identical')}</p>
      ) : (
        <ul className="space-y-0.5 text-muted">
          {d.voice && (
            <li>{t('takes.voiceDiff', { from: voiceName(d.voice.from), to: voiceName(d.voice.to) })}</li>
          )}
          {d.textChanged && <li>{t('takes.textDiff')}</li>}
          {d.settings.map((s) => (
            <li key={s.key}>
              {settingLabel(s.key, undefined)}: <span className="font-mono">{fmt(s.from)}</span> →{' '}
              <span className="font-mono text-accent">{fmt(s.to)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
