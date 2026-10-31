import { useMemo, useRef, useState } from 'react';
import { SETTING_KEYS, type RenderJobDto } from '@voxstudio/contracts';
import { api, assetUrl, describeError } from '../api/client';
import { useVoice, useVoices, waitForJob } from '../api/hooks';
import { Empty, ErrorNote, Spinner, SupportBadge, TierBadge } from '../components/ui';
import {
  AiBadge,
  DatasetPanel,
  VoiceProfileInfo,
  engineShortName,
  labelFor,
} from '../components/VoiceProfilePanel';
import { accentName, languageName, settingLabel, tierNote, unitLabel, useI18n } from '../i18n';

export function VoicesPage() {
  const { t, lang } = useI18n();
  const voices = useVoices();
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [engine, setEngine] = useState('');
  const [accent, setAccent] = useState('');
  const [gender, setGender] = useState('');
  const engines = useMemo(
    () => [...new Set((voices.data ?? []).map((v) => v.engineId))].sort(),
    [voices.data],
  );
  const accents = useMemo(
    () => [...new Set((voices.data ?? []).map((v) => v.accent).filter((a): a is string => !!a))].sort(),
    [voices.data],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const filtered = useMemo(
    () =>
      (voices.data ?? [])
        .filter(
          (v) =>
            (!tier || v.supportTier === tier) &&
            (!engine || v.engineId === engine) &&
            (!accent || v.accent === accent) &&
            (!gender || v.gender === gender) &&
            (!q ||
              `${labelFor(v, voices.data ?? [], lang)} ${v.displayName} ${v.locale} ${languageName(v.locale, lang)}`
                .toLowerCase()
                .includes(q.toLowerCase())),
        )
        .sort((a, b) =>
          labelFor(a, voices.data ?? [], lang).localeCompare(labelFor(b, voices.data ?? [], lang), lang),
        ),
    [voices.data, q, tier, engine, accent, gender, lang],
  );
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_420px] max-[1000px]:grid-cols-1">
      <div className="overflow-auto p-6 scroll-thin">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-lg font-semibold">{t('voices.title')}</h1>
          <label className="sr-only" htmlFor="vq">
            {t('voices.filter')}
          </label>
          <input
            id="vq"
            className="input w-60"
            placeholder={t('voices.filter')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="sr-only" htmlFor="vt">
            {t('voices.tier')}
          </label>
          <select id="vt" className="input w-44" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">{t('voices.allTiers')}</option>
            <option value="verified">{t('tier.verified')}</option>
            <option value="experimental">{t('tier.experimental')}</option>
          </select>
          <label className="sr-only" htmlFor="ve">
            {t('voices.engine')}
          </label>
          <select id="ve" className="input w-44" value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="">{t('voices.allEngines')}</option>
            {engines.map((e) => (
              <option key={e} value={e}>
                {engineShortName(e)}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="va">
            {t('voices.accent')}
          </label>
          <select id="va" className="input w-44" value={accent} onChange={(e) => setAccent(e.target.value)}>
            <option value="">{t('voices.allAccents')}</option>
            {accents.map((a) => (
              <option key={a} value={a}>
                {accentName(a, lang)}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="vg">
            {t('voices.gender')}
          </label>
          <select id="vg" className="input w-40" value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">{t('voices.allGenders')}</option>
            <option value="female">{t('profile.gender.female')}</option>
            <option value="male">{t('profile.gender.male')}</option>
          </select>
        </header>
        <p className="mb-4 max-w-3xl text-sm text-muted">{t('voices.intro')}</p>
        {voices.isLoading && <Spinner />}
        {voices.error && <ErrorNote error={voices.error} />}
        {voices.data && filtered.length === 0 && <Empty title={t('voices.none')} />}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
          {filtered.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelected(v.id)}
              className={`card p-3 text-left hover:border-line-strong ${selected === v.id ? 'border-accent' : ''}`}
              aria-pressed={selected === v.id}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{labelFor(v, voices.data ?? [], lang)}</span>
                <TierBadge tier={v.supportTier} />
                <AiBadge usesAi={v.usesAi} />
              </div>
              <p className="mt-1 font-mono text-xs text-muted">
                {v.locale} · {engineShortName(v.engineId)}
              </p>
            </button>
          ))}
        </div>
      </div>
      <aside
        className="overflow-auto border-l border-line bg-panel p-5 scroll-thin max-[1000px]:border-l-0 max-[1000px]:border-t"
        aria-label={t('voices.details')}
      >
        {selected ? <VoiceDetail id={selected} /> : <p className="text-sm text-muted">{t('voices.pick')}</p>}
      </aside>
    </div>
  );
}

function VoiceDetail({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const v = useVoice(id);
  const all = useVoices();
  const sample = v.data?.sample.text ?? '';
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  if (v.isLoading) return <Spinner />;
  if (v.error || !v.data) return <ErrorNote error={v.error ?? t('voices.none')} />;
  const d = v.data;
  const speak = async () => {
    setState('busy');
    setError(null);
    try {
      const job = await api<RenderJobDto>('/previews', {
        method: 'POST',
        body: { text: text || sample, voiceId: d.id, locale: d.locale },
      });
      const done = await waitForJob(job);
      if (done.status !== 'succeeded' || !done.resultAsset)
        throw new Error(done.errorMessage ?? t('player.previewFailed'));
      setAudioId(done.resultAsset.id);
      setState('idle');
      setTimeout(() => void audio.current?.play().catch(() => undefined), 50);
    } catch (e) {
      setError(describeError(e));
      setState('error');
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {labelFor(d, all.data ?? [], lang)} <TierBadge tier={d.supportTier} /> <AiBadge usesAi={d.usesAi} />
        </h2>
        <p className="mt-1 font-mono text-xs text-muted">
          {d.locale} · {d.engineName} {d.engineVersion}
        </p>
        <p className="mt-2 text-xs text-muted">{tierNote(d.supportTier)}</p>
      </div>
      <div className="card p-3">
        <label className="label" htmlFor="sample">
          {t('voices.sampleLabel')}
        </label>
        <textarea
          id="sample"
          className="input h-24 resize-none"
          lang={d.locale}
          maxLength={1000}
          placeholder={sample}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm"
            disabled={state === 'busy' || !(text || sample)}
            onClick={() => void speak()}
          >
            {state === 'busy' ? t('voices.speaking') : t('voices.speak')}
          </button>
          {audioId && (
            <audio
              ref={audio}
              controls
              src={assetUrl(audioId)}
              className="h-8 flex-1"
              aria-label={t('voices.sampleAria')}
            />
          )}
        </div>
        <p className="mt-2 text-[11px] text-dim">{t('profile.sampleNote')}</p>
        {error && (
          <div className="mt-2">
            <ErrorNote error={error} />
          </div>
        )}
      </div>
      <VoiceProfileInfo d={d} />
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('voices.caps')}</h3>
        <table className="w-full text-xs">
          <thead className="text-left text-dim">
            <tr>
              <th className="py-1 font-medium">{t('voices.capControl')}</th>
              <th className="py-1 font-medium">{t('voices.capImpl')}</th>
              <th className="py-1 font-medium">{t('voices.capRange')}</th>
            </tr>
          </thead>
          <tbody>
            {SETTING_KEYS.map((k) => {
              const c = d.capabilities[k];
              return (
                <tr key={k} className="border-t border-line">
                  <td className="py-1.5">{settingLabel(k, c)}</td>
                  <td className="py-1.5">
                    <SupportBadge support={c.support} />
                  </td>
                  <td className="py-1.5 font-mono text-muted">
                    {c.kind === 'number'
                      ? `${c.min.toLocaleString(lang)}–${c.max.toLocaleString(lang)} ${unitLabel(c.unit)}`
                      : c.kind === 'enum'
                        ? t('voices.options', { n: c.options.length })
                        : t('voices.onOff')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-dim">{t('voices.controlsNote')}</p>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {t('voices.limitations')}
        </h3>
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
          {d.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
      <DatasetPanel d={d} />
      {Array.isArray((d.qaReport as { checks?: unknown[] })?.checks) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">{t('voices.qaRecord')}</summary>
          <ul className="mt-2 space-y-0.5">
            {(d.qaReport as { checks: { name: string; ok: boolean; detail: string }[] }).checks.map((c) => (
              <li key={c.name} className={c.ok ? 'text-muted' : 'text-danger'}>
                {c.ok ? '✓' : '✕'} {c.name}: {c.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
