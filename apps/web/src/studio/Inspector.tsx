import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ParameterCapability,
  ParameterGroup,
  PresetDto,
  SettingKey,
  SynthesisSettings,
  VoiceCapabilities,
  VoiceDto,
  VoiceProfileDto,
} from '@voxstudio/contracts';
import { SETTING_KEYS } from '@voxstudio/contracts';
import { api } from '../api/client';
import { qk, usePresets, useVoice, useVoices } from '../api/hooks';
import { useUiMode } from '../app/uiMode';
import { Dialog, ErrorNote, Spinner, SupportBadge, TierBadge } from '../components/ui';
import {
  AiBadge,
  DatasetPanel,
  VoiceProfileInfo,
  engineShortName,
  labelFor,
} from '../components/VoiceProfilePanel';
import { VoiceGalleryDialog } from '../components/VoiceGallery';
import { VoiceSample } from '../components/VoiceSample';
import {
  accentName,
  languageName,
  presetDesc,
  presetName,
  settingDesc,
  settingLabel,
  tierNote,
  unitLabel,
  useI18n,
  variantLabel,
} from '../i18n';
import type { MessageKey } from '../i18n/en';
import { applyVoiceSettings, updateSegment } from './actions';
import { reconcileSettings } from './reconcile';
import { availableAccents, availableGenders, pickVoice, type Gender, type VoiceWish } from './voicePick';
import { useStudio, type DraftSegment } from './store';

const GROUPS: { id: ParameterGroup; label: MessageKey }[] = [
  { id: 'voice', label: 'insp.group.voice' },
  { id: 'timing', label: 'insp.group.timing' },
  { id: 'emphasis', label: 'insp.group.emphasis' },
  { id: 'dsp', label: 'insp.group.dsp' },
  { id: 'eq', label: 'insp.group.eq' },
];
/** The few controls a non-technical user needs. */
const SIMPLE_KEYS: SettingKey[] = ['variant', 'rate', 'pitch', 'volumeDb', 'pauseAfterMs'];

/**
 * Simple mode shows speed and pitch. When a voice has no engine-native speed or pitch (AI voices), the equivalent
 * audio-processing control is offered instead so a non-technical user can still change them.
 */
export function simpleKeysFor(caps: VoiceCapabilities | undefined): SettingKey[] {
  if (!caps) return SIMPLE_KEYS;
  return SIMPLE_KEYS.map((k) =>
    k === 'rate' && caps.rate.support === 'unsupported' && caps.tempo.support !== 'unsupported'
      ? 'tempo'
      : k === 'pitch' &&
          caps.pitch.support === 'unsupported' &&
          caps.pitchShiftSemitones.support !== 'unsupported'
        ? 'pitchShiftSemitones'
        : k,
  );
}

export function defaultsFrom(caps: VoiceCapabilities): SynthesisSettings {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, caps[k].default])) as SynthesisSettings;
}

/** Client mirror of the server's preset application, used to show what will change. */
export function presetDiff(settings: SynthesisSettings, preset: PresetDto, caps: VoiceCapabilities) {
  const next = { ...settings } as Record<string, unknown>;
  const changes: { key: SettingKey; label: string; from: unknown; to: unknown }[] = [];
  const skipped: string[] = [];
  for (const key of SETTING_KEYS) {
    const to = preset.parameters[key];
    if (to === undefined) continue;
    const cap = caps[key];
    const ok =
      cap.support !== 'unsupported' &&
      (cap.kind !== 'number' || (typeof to === 'number' && to >= cap.min && to <= cap.max)) &&
      (cap.kind !== 'enum' || cap.options.some((o) => o.value === to));
    if (!ok) {
      skipped.push(settingLabel(key, cap));
      continue;
    }
    if (settings[key] !== to) changes.push({ key, label: settingLabel(key, cap), from: settings[key], to });
    next[key] = to;
  }
  return { settings: next as SynthesisSettings, changes, skipped };
}

/** Voices grouped by language, labelled in the UI language. */
export function VoiceOptions({ voices, current }: { voices: VoiceDto[]; current?: string }) {
  const { lang, t } = useI18n();
  const groups = useMemo(() => {
    const m = new Map<string, VoiceDto[]>();
    for (const v of voices) {
      const key = languageName(v.locale.split('-')[0]!, lang);
      m.set(key, [...(m.get(key) ?? []), v]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], lang));
  }, [voices, lang]);
  return (
    <>
      {groups.map(([name, list]) => (
        <optgroup key={name} label={name}>
          {list.map((v) => (
            <option key={v.id} value={v.id}>
              {labelFor(v, voices, lang)}
            </option>
          ))}
        </optgroup>
      ))}
      {current && !voices.some((v) => v.id === current) && (
        <option value={current}>
          {current} {t('insp.unavailable')}
        </option>
      )}
    </>
  );
}

export function Inspector() {
  const { t, lang } = useI18n();
  const simple = useUiMode((s) => s.mode) === 'simple';
  const selectedId = useStudio((s) => s.selectedId);
  const seg = useStudio((s) => s.segments.find((x) => x.id === s.selectedId));
  const checked = useStudio((s) => s.checked);
  const voices = useVoices();
  const voice = useVoice(seg?.voiceId ?? null);
  const [group, setGroup] = useState<ParameterGroup>('voice');
  const [presetDialog, setPresetDialog] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [gallery, setGallery] = useState(false);
  const qc = useQueryClient();

  if (!seg || !selectedId) return <div className="p-4 text-sm text-muted">{t('editor.noSelection')}</div>;
  const caps = voice.data?.capabilities;
  const targets = checked.length ? checked : [seg.id];

  const setSetting = (key: SettingKey, value: number | boolean | string) =>
    updateSegment(
      seg.id,
      { settings: { ...seg.settings, [key]: value } as SynthesisSettings },
      `setting:${seg.id}:${key}`,
    );

  /**
   * Switch voice (possibly to another engine). Settings the new voice cannot honour are reset or clamped by
   * `reconcileSettings` and reported, so an engine switch never leaves invalid settings in the project.
   */
  const changeVoice = async (v: VoiceDto, scope: string[]) => {
    setNotice(null);
    try {
      const next = await qc.fetchQuery({
        queryKey: qk.voice(v.id),
        queryFn: () => api<VoiceProfileDto>(`/voices/${encodeURIComponent(v.id)}/profile`),
        staleTime: 300_000,
      });
      const st = useStudio.getState();
      const messages = new Set<string>();
      const touched = st.segments.map((s) => {
        if (!scope.includes(s.id)) return s;
        const r = reconcileSettings(s.settings, next.capabilities);
        r.changes.forEach((c) => messages.add(settingLabel(c.key, next.capabilities[c.key])));
        return { ...s, voiceId: v.id, locale: v.locale, settings: r.settings };
      });
      st.commit(touched);
      const langChanged = seg.locale.split('-')[0] !== v.locale.split('-')[0];
      // A change of engine (for example rule-based to AI) is never silent.
      const engineChanged = voice.data && voice.data.engineId !== v.engineId;
      setNotice(
        [
          langChanged ? t('insp.language') : '',
          engineChanged
            ? t('insp.engineChanged', {
                from: engineShortName(voice.data!.engineId),
                to: engineShortName(v.engineId),
              })
            : '',
          messages.size ? t('insp.reconciled', { list: [...messages].join(', ') }) : '',
        ]
          .filter(Boolean)
          .join(' ') || null,
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  // Region and gender choices: only combinations that really exist among the installed voices are offered.
  const currentVoice = (voices.data ?? []).find((v) => v.id === seg.voiceId);
  const accents = currentVoice
    ? availableAccents(voices.data ?? [], currentVoice.locale, currentVoice.gender)
    : [];
  const genders = currentVoice
    ? availableGenders(voices.data ?? [], currentVoice.locale, currentVoice.accent)
    : [];
  const chooseVoiceBy = (wish: VoiceWish) => {
    if (!currentVoice) return;
    const v = pickVoice(voices.data ?? [], currentVoice, wish);
    if (!v) return setNotice(t('create.noMatch'));
    void changeVoice(v, targets);
  };
  const applyAll = () => {
    const r = applyVoiceSettings(
      { voiceId: seg.voiceId, locale: seg.locale, settings: seg.settings },
      useStudio.getState().segments.map((s) => s.id),
    );
    setNotice(
      [t('takes.applied', { n: r.applied }), r.skipped ? t('takes.skipped', { n: r.skipped }) : '']
        .filter(Boolean)
        .join(' '),
    );
  };
  const classes = caps
    ? {
        native: SETTING_KEYS.filter((k) => caps[k].support === 'native').length,
        dsp: SETTING_KEYS.filter((k) => caps[k].support === 'dsp').length,
        off: SETTING_KEYS.filter((k) => caps[k].support === 'unsupported').length,
      }
    : null;
  const visible = (k: SettingKey) => !simple || caps?.[k].support !== 'unsupported';
  const keys = simple
    ? simpleKeysFor(caps).filter(visible)
    : SETTING_KEYS.filter((k) => caps?.[k].group === group);

  return (
    <section aria-label={t('insp.title')} className="flex h-full flex-col">
      <div className="max-h-[55%] space-y-3 overflow-auto border-b border-line p-3 scroll-thin">
        <div>
          <label className="label" htmlFor="voice-select">
            {t('insp.voice')}{' '}
            {checked.length > 1 && (
              <span className="text-accent">{t('insp.appliesTo', { n: checked.length })}</span>
            )}
          </label>
          <select
            id="voice-select"
            className="input"
            value={seg.voiceId}
            onChange={(e) => {
              const v = voices.data?.find((x) => x.id === e.target.value);
              if (v) void changeVoice(v, targets);
            }}
          >
            <VoiceOptions voices={voices.data ?? []} current={seg.voiceId} />
          </select>
          <button className="btn btn-sm mt-2 w-full" onClick={() => setGallery(true)}>
            {t('gallery.open')}
          </button>
        </div>
        {(accents.length > 1 || genders.length > 0) && (
          <div className="grid grid-cols-2 gap-2">
            {accents.length > 1 && (
              <div>
                <label className="label" htmlFor="accent-select">
                  {t('insp.accent')}
                </label>
                <select
                  id="accent-select"
                  className="input"
                  value={voice.data?.accent ?? ''}
                  onChange={(e) =>
                    chooseVoiceBy({ accent: e.target.value, gender: currentVoice?.gender ?? undefined })
                  }
                >
                  {accents.map((a) => (
                    <option key={a} value={a}>
                      {accentName(a, lang)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {genders.length > 0 && (
              <div>
                <label className="label" htmlFor="gender-select">
                  {t('insp.gender')}
                </label>
                <select
                  id="gender-select"
                  className="input"
                  value={currentVoice?.gender ?? ''}
                  onChange={(e) =>
                    chooseVoiceBy({
                      accent: currentVoice?.accent ?? undefined,
                      gender: e.target.value as Gender,
                    })
                  }
                >
                  {!currentVoice?.gender && <option value="">{t('insp.genderUnknown')}</option>}
                  {genders.map((g) => (
                    <option key={g} value={g}>
                      {t(`profile.gender.${g}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
        {voice.data?.usesAi && (
          <p className="text-[11px] leading-snug text-accent">
            <AiBadge usesAi /> {t('profile.usesAi.yes')}
          </p>
        )}
        {voice.data && (
          <dl className="text-[11px] leading-snug text-muted" aria-label={t('profile.info')}>
            <dt className="sr-only">{t('profile.locale')}</dt>
            <dd className="inline">
              {languageName(voice.data.locale, lang)} · {accentName(voice.data.accent, lang)}
            </dd>
            <dt className="sr-only">{t('profile.engine')}</dt>
            <dd className="inline"> · {voice.data.engineName}</dd>
            <dt className="sr-only">{t('profile.dataset')}</dt>
            <dd className="block">
              {voice.data.dataset
                ? voice.data.dataset.complete
                  ? t('insp.dataset.complete')
                  : t('insp.dataset.incomplete')
                : voice.data.usesAi
                  ? t('insp.dataset.neural')
                  : t('insp.dataset.rules')}
              {voice.data.dataset?.provenance.kind === 'ai-generated' && ' ' + t('insp.dataset.ai')}
            </dd>
          </dl>
        )}
        {voice.data && voice.data.sample.text && (
          <VoiceSample
            compact
            voiceId={voice.data.id}
            locale={voice.data.locale}
            text={voice.data.sample.text}
          />
        )}
        {voice.data && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <TierBadge tier={voice.data.supportTier} />
            <span className="text-[11px] leading-snug text-dim">{tierNote(voice.data.supportTier)}</span>
            {!simple && (
              <span className="w-full text-[11px] text-dim">
                {t('insp.engineInfo', {
                  engine: voice.data.engineName,
                  version: voice.data.engineVersion,
                  license: voice.data.license,
                })}
              </span>
            )}
          </div>
        )}
        {notice && (
          <p role="status" className="text-[11px] leading-snug text-warn">
            {notice}
          </p>
        )}
        {voice.data?.dataset && !voice.data.dataset.complete && (
          <p className="text-[11px] leading-snug text-warn">{t('insp.datasetIncomplete')}</p>
        )}
        <div className="flex gap-2">
          <button className="btn btn-sm flex-1" onClick={() => setPresetDialog(true)} disabled={!caps}>
            {t('insp.applyPreset')}
          </button>
          <button
            className="btn btn-sm flex-1"
            disabled={!caps}
            onClick={() => caps && updateSegment(seg.id, { settings: defaultsFrom(caps) })}
          >
            {t('insp.resetDefaults')}
          </button>
        </div>
        <button className="btn btn-sm w-full" disabled={!caps} onClick={applyAll}>
          {t('insp.applyAll')}
        </button>
        {!simple && voice.data && classes && (
          <details className="rounded-md border border-line p-2 text-[11px] text-muted">
            <summary className="cursor-pointer text-xs">
              {voice.data.engineName}: {t('insp.engineSummary', classes)}
            </summary>
            <p className="mt-1 leading-snug text-dim">{voice.data.synthesisMethod}</p>
            <p className="mt-1 leading-snug text-dim">{t('insp.engineExplain')}</p>
          </details>
        )}
      </div>
      {!simple && (
        <div
          role="tablist"
          aria-label={t('insp.groups')}
          className="flex flex-wrap border-b border-line px-2"
        >
          {GROUPS.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={group === g.id}
              className={`px-2 py-2 text-xs font-medium ${group === g.id ? 'border-b-2 border-accent text-fg' : 'text-muted hover:text-fg'}`}
              onClick={() => setGroup(g.id)}
            >
              {t(g.label)}
            </button>
          ))}
        </div>
      )}
      <div role={simple ? undefined : 'tabpanel'} className="flex-1 space-y-4 overflow-auto p-3 scroll-thin">
        {voice.isLoading && <Spinner label={t('insp.loadingCaps')} />}
        {voice.error && <ErrorNote error={voice.error} />}
        {caps &&
          keys.map((k) => (
            <Control
              key={k}
              name={k}
              cap={caps[k]}
              value={seg.settings[k]}
              simple={simple}
              onChange={(v) => setSetting(k, v)}
            />
          ))}
        {!simple && group === 'dsp' && (
          <p className="text-[11px] leading-snug text-dim">{t('insp.dspNote')}</p>
        )}
        {!simple && group === 'emphasis' && (
          <p className="text-[11px] leading-snug text-dim">{t('insp.emphasisNote')}</p>
        )}
        {simple && <p className="text-[11px] leading-snug text-dim">{t('insp.simpleNote')}</p>}
      </div>
      {voice.data && !simple && (
        <div className="border-t border-line p-3">
          <button
            className="text-xs text-muted hover:text-fg"
            aria-expanded={details}
            onClick={() => setDetails((x) => !x)}
          >
            {details ? '▾' : '▸'} {t('profile.info')}
          </button>
          {details && (
            <div className="mt-3 space-y-4">
              <VoiceProfileInfo d={voice.data} />
              <DatasetPanel d={voice.data} />
            </div>
          )}
        </div>
      )}
      {voice.data && !simple && (
        <details className="border-t border-line p-3 text-[11px] text-dim">
          <summary className="cursor-pointer text-xs text-muted">{t('insp.limitations')}</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {voice.data.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      )}
      {gallery && (
        <VoiceGalleryDialog
          voices={(voices.data ?? []).filter((v) => v.locale === (currentVoice?.locale ?? seg.locale))}
          all={voices.data ?? []}
          value={seg.voiceId}
          onPick={(id) => {
            const v = voices.data?.find((x) => x.id === id);
            if (v) void changeVoice(v, targets);
          }}
          onClose={() => setGallery(false)}
        />
      )}
      {presetDialog && caps && (
        <PresetDialog targets={targets} caps={caps} onClose={() => setPresetDialog(false)} />
      )}
    </section>
  );
}

/** Friendly end labels for the sliders shown in simple mode. */
const SCALE: Partial<Record<SettingKey, [MessageKey, MessageKey]>> = {
  rate: ['insp.speed.slow', 'insp.speed.fast'],
  pitch: ['insp.pitch.low', 'insp.pitch.high'],
  // Audio-processing equivalents offered in simple mode for voices without native speed/pitch (see simpleKeysFor).
  tempo: ['insp.speed.slow', 'insp.speed.fast'],
  pitchShiftSemitones: ['insp.pitch.low', 'insp.pitch.high'],
};

/** Friendly simple-mode names for the audio-processing stand-ins. */
const SIMPLE_ALIAS: Partial<Record<SettingKey, MessageKey>> = {
  tempo: 'setting.rate.label',
  pitchShiftSemitones: 'setting.pitch.label',
};

function Control({
  name,
  cap,
  value,
  simple,
  onChange,
}: {
  name: SettingKey;
  cap: ParameterCapability;
  value: unknown;
  simple: boolean;
  onChange: (v: number | boolean | string) => void;
}) {
  const { t, lang } = useI18n();
  const id = `ctl-${name}`;
  const alias = simple ? SIMPLE_ALIAS[name] : undefined;
  const label = alias ? t(alias) : settingLabel(name, cap);
  const disabled = cap.support === 'unsupported';
  const header = (
    <div className="mb-1 flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <SupportBadge support={cap.support} />
      {value !== cap.default && !disabled && (
        <button
          className="ml-auto text-[11px] text-muted hover:text-fg"
          onClick={() => onChange(cap.default)}
          aria-label={t('insp.resetAria', { label })}
        >
          {t('insp.resetOne')}
        </button>
      )}
    </div>
  );
  const desc = (
    <p className="mt-1 text-[11px] leading-snug text-dim">
      {disabled ? t('insp.notAvailable') + ' ' : ''}
      {settingDesc(name, cap)}
    </p>
  );
  if (cap.kind === 'enum')
    return (
      <div>
        {header}
        <select
          id={id}
          className="input"
          disabled={disabled}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {cap.options.map((o) => (
            <option key={o.value} value={o.value}>
              {variantLabel(o.value, o.label)}
            </option>
          ))}
        </select>
        {!simple && desc}
      </div>
    );
  if (cap.kind === 'boolean')
    return (
      <div>
        {header}
        <label className="flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />{' '}
          {t('common.enabled')}
        </label>
        {desc}
      </div>
    );
  const v = Number(value);
  const outside =
    (cap.recommendedMin !== undefined && v < cap.recommendedMin) ||
    (cap.recommendedMax !== undefined && v > cap.recommendedMax);
  const isPause = name === 'pauseBeforeMs' || name === 'pauseAfterMs';
  const display =
    simple && isPause
      ? t('insp.seconds', { n: (v / 1000).toLocaleString(lang) })
      : `${v.toLocaleString(lang)} ${unitLabel(cap.unit)}`.trim();
  const scale = SCALE[name];
  return (
    <div>
      {header}
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          className="flex-1"
          min={cap.min}
          max={simple && isPause ? 3000 : cap.max}
          step={cap.step}
          value={v}
          disabled={disabled}
          aria-valuetext={display}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {simple ? (
          <span className="w-16 text-right font-mono text-xs text-muted">{display}</span>
        ) : (
          <>
            <input
              type="number"
              aria-label={t('insp.valueAria', { label })}
              className="input w-20 py-1 text-right font-mono text-xs"
              min={cap.min}
              max={cap.max}
              step={cap.step}
              value={v}
              disabled={disabled}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChange(Math.min(cap.max, Math.max(cap.min, n)));
              }}
            />
            <span className="w-14 text-[11px] text-dim">{unitLabel(cap.unit)}</span>
          </>
        )}
      </div>
      {simple && scale && (
        <div className="mt-0.5 flex justify-between text-[11px] text-dim" aria-hidden>
          <span>{t(scale[0])}</span>
          <span>{name === 'rate' || name === 'tempo' ? t('insp.speed.normal') : ''}</span>
          <span>{t(scale[1])}</span>
        </div>
      )}
      {outside && (
        <p className="mt-1 text-[11px] text-warn">
          {t('insp.outside', { min: cap.recommendedMin ?? cap.min, max: cap.recommendedMax ?? cap.max })}
        </p>
      )}
      {(!simple || name === 'volumeDb') && desc}
    </div>
  );
}

function PresetDialog({
  targets,
  caps,
  onClose,
}: {
  targets: string[];
  caps: VoiceCapabilities;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const presets = usePresets();
  const segments = useStudio((s) => s.segments);
  const [presetId, setPresetId] = useState<string>('');
  const preset = presets.data?.find((p) => p.id === presetId);
  const targetSegs = useMemo(() => segments.filter((s) => targets.includes(s.id)), [segments, targets]);
  const diffs = useMemo(
    () => (preset ? targetSegs.map((s) => ({ seg: s, ...presetDiff(s.settings, preset, caps) })) : []),
    [preset, targetSegs, caps],
  );
  const apply = () => {
    const st = useStudio.getState();
    const byId = new Map<string, DraftSegment['settings']>(diffs.map((d) => [d.seg.id, d.settings]));
    st.commit(st.segments.map((s) => (byId.has(s.id) ? { ...s, settings: byId.get(s.id)! } : s)));
    onClose();
  };
  return (
    <Dialog title={t('preset.dialogTitle', { n: targets.length })} onClose={onClose}>
      {presets.isLoading && <Spinner />}
      <label className="label" htmlFor="preset">
        {t('preset.label')}
      </label>
      <select
        id="preset"
        className="input mb-3"
        value={presetId}
        onChange={(e) => setPresetId(e.target.value)}
      >
        <option value="">{t('preset.choose')}</option>
        {presets.data?.map((p) => (
          <option key={p.id} value={p.id}>
            {presetName(p)} {p.isBuiltin ? t('preset.builtin') : ''}
          </option>
        ))}
      </select>
      {preset && (
        <div className="space-y-3 text-sm">
          <p className="text-muted">{presetDesc(preset)}</p>
          <div className="card max-h-60 overflow-auto p-3 scroll-thin">
            <p className="label">{t('preset.changes')}</p>
            {diffs.every((d) => d.changes.length === 0) && (
              <p className="text-muted">{t('preset.noChanges')}</p>
            )}
            {diffs.map((d) =>
              d.changes.length ? (
                <div key={d.seg.id} className="mb-2">
                  <p className="text-xs text-dim">
                    {t('preset.paragraph', { n: segments.indexOf(d.seg) + 1 })}
                  </p>
                  <ul className="text-xs">
                    {d.changes.map((c) => (
                      <li key={c.key}>
                        {c.label}: <span className="font-mono text-muted">{String(c.from)}</span> →{' '}
                        <span className="font-mono text-accent">{String(c.to)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            {diffs[0]?.skipped.length ? (
              <p className="mt-2 text-xs text-warn">
                {t('preset.skipped', { list: diffs[0].skipped.join(', ') })}
              </p>
            ) : null}
          </div>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={!preset} onClick={apply}>
          {t('common.apply')}
        </button>
      </div>
    </Dialog>
  );
}
