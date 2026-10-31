import type { DatasetReportDto, VoiceDto, VoiceProfileDto } from '@voxstudio/contracts';
import { accentName, languageName, settingLabel, translate, unitLabel, useI18n, voiceLabel } from '../i18n';
import type { MessageKey } from '../i18n/en';

const ENGINE_NAMES: Record<string, string> = {
  espeak: 'eSpeak NG',
  vnunit: 'VoxStudio Vietnamese',
  vieneu: 'VieNeu-TTS',
};
export const engineShortName = (id: string): string => ENGINE_NAMES[id] ?? id;

/** Voice label; when several voices share the language and accent, the engine (or preset) name tells them apart. AI voices say so. */
export function labelFor(v: VoiceDto, all: VoiceDto[], lang: 'en' | 'vi'): string {
  const base = voiceLabel(v, lang);
  const clash = all.some((o) => o.id !== v.id && voiceLabel(o, lang) === base);
  const same = all.some((o) => o.id !== v.id && o.engineId === v.engineId && voiceLabel(o, lang) === base);
  const suffix = clash
    ? ` · ${same ? v.displayName.split('—').pop()!.trim() : engineShortName(v.engineId)}`
    : '';
  const gender = v.gender
    ? ` · ${translate(`profile.gender.${v.gender}` as MessageKey, undefined, lang)}`
    : '';
  return `${base}${gender}${suffix}${v.usesAi ? ' · AI' : ''}`;
}

/** Small "AI" tag shown next to voices produced by an AI model (ADR 0008). */
export function AiBadge({ usesAi }: { usesAi: boolean }) {
  const { t } = useI18n();
  if (!usesAi) return null;
  return (
    <span className="badge bg-accent/15 text-accent" title={t('ai.badgeTitle')}>
      {t('ai.badge')}
    </span>
  );
}

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="flex gap-2 border-t border-line py-1.5 first:border-t-0">
    <dt className="w-36 shrink-0 text-dim">{k}</dt>
    <dd className="min-w-0 flex-1 break-words">{children}</dd>
  </div>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section>
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
    {children}
  </section>
);

/** Voice information, defaults, validation and sound inventory (everything except live playback and controls). */
export function VoiceProfileInfo({ d }: { d: VoiceProfileDto }) {
  const { t, lang } = useI18n();
  const gender =
    d.gender === 'female'
      ? t('profile.gender.female')
      : d.gender === 'male'
        ? t('profile.gender.male')
        : t('profile.gender.unknown');
  const v = d.validation;
  const validation =
    v.state === 'reviewed'
      ? t('profile.validation.reviewed', { name: v.reviewer ?? '', date: v.reviewedOn ?? '' })
      : t(`profile.validation.${v.state}` as MessageKey);
  const defaults: [string, string][] = (
    ['rate', 'pitch', 'volumeDb', 'pauseBeforeMs', 'pauseAfterMs'] as const
  ).map((k) => [
    settingLabel(k, d.capabilities[k]),
    `${d.defaults[k].toLocaleString(lang)} ${unitLabel(d.capabilities[k].kind === 'number' ? d.capabilities[k].unit : '')}`.trim(),
  ]);
  return (
    <>
      <Section title={t('profile.info')}>
        <dl className="text-xs">
          <Row k={t('profile.locale')}>
            {languageName(d.locale, lang)} <span className="font-mono text-muted">{d.locale}</span>
          </Row>
          <Row k={t('profile.accent')}>{accentName(d.accent, lang)}</Row>
          <Row k={t('profile.gender')}>{gender}</Row>
          <Row k={t('profile.engine')}>
            {d.engineName} <span className="font-mono text-muted">{d.engineVersion}</span>
          </Row>
          <Row k={t('profile.method')}>{d.synthesisMethod}</Row>
          <Row k={t('profile.usesAi')}>{d.usesAi ? t('profile.usesAi.yes') : t('profile.usesAi.no')}</Row>
          <Row k={t('profile.dbVersion')}>{d.voiceDatabaseVersion}</Row>
          <Row k={t('profile.license')}>{d.license}</Row>
          <Row k={t('profile.validation')}>
            {validation}
            {v.state !== 'reviewed' && v.detail ? <span className="block text-dim">{v.detail}</span> : null}
          </Row>
        </dl>
      </Section>
      <Section title={t('profile.defaults')}>
        <dl className="text-xs">
          {defaults.map(([k, val]) => (
            <Row key={k} k={k}>
              <span className="font-mono">{val}</span>
            </Row>
          ))}
        </dl>
      </Section>
      <Section title={t('profile.inventory')}>
        {d.inventory.kind === 'rule-based' ? (
          <p className="text-xs text-muted">{t('profile.inventory.rules')}</p>
        ) : d.inventory.kind === 'neural' ? (
          <p className="text-xs text-muted">{t('profile.inventory.neural')}</p>
        ) : (
          <div className="space-y-1 text-xs text-muted">
            <p>{t('profile.inventory.units', { n: d.inventory.recordedSyllables ?? 0 })}</p>
            {(
              [
                ['profile.dataset.onsets', d.inventory.onsets],
                ['profile.dataset.nuclei', d.inventory.nuclei],
                ['profile.dataset.codas', d.inventory.codas],
                ['profile.dataset.tones', d.inventory.tones],
              ] as [MessageKey, string[]][]
            ).map(([k, list]) => (
              <p key={k}>
                <span className="text-dim">{t(k)}: </span>
                <span className="font-mono">{list.map((x) => x || '∅').join(' ')}</span>
              </p>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

const COMPONENTS = [
  ['onsets', 'profile.dataset.onsets'],
  ['nuclei', 'profile.dataset.nuclei'],
  ['codas', 'profile.dataset.codas'],
  ['tones', 'profile.dataset.tones'],
] as const;

/** Dataset completeness, missing-unit report, recording quality and audit trail. */
export function DatasetPanel({ d }: { d: VoiceProfileDto }) {
  const { t, lang } = useI18n();
  const ds: DatasetReportDto | null = d.dataset;
  if (!ds)
    return (
      <Section title={t('profile.dataset')}>
        <p className="text-xs text-muted">
          {d.usesAi ? t('profile.dataset.neural') : t('profile.dataset.none')}
        </p>
      </Section>
    );
  const r = ds.recording;
  return (
    <Section title={t('profile.dataset')}>
      <div className="space-y-3 text-xs">
        <p>
          <span
            className={`badge ${ds.complete ? 'bg-native/15 text-native' : 'bg-warn/15 text-warn'}`}
            role="status"
          >
            {ds.complete ? t('profile.dataset.complete') : t('profile.dataset.incomplete')}
          </span>
        </p>
        <dl>
          <Row k={t('profile.dataset.version')}>{ds.datasetVersion}</Row>
          <Row k={t('profile.dataset.units')}>{ds.units.toLocaleString(lang)}</Row>
          <Row k={t('profile.dataset.syllables')}>{ds.distinctSyllables.toLocaleString(lang)}</Row>
          <Row k={t('profile.dataset.single')}>{ds.singleInstanceSyllables.toLocaleString(lang)}</Row>
          <Row k={t('profile.dataset.source')}>
            {t(('profile.dataset.src.' + ds.provenance.kind) as MessageKey)}
            {ds.provenance.generator && (
              <span className="block text-dim">
                {t('profile.dataset.generator', {
                  name: ds.provenance.generator.name,
                  version: ds.provenance.generator.version,
                  license: ds.provenance.generator.license,
                })}
              </span>
            )}
          </Row>
          <Row k={t('profile.dataset.attribution')}>
            {ds.license.attribution || t('profile.dataset.noAttribution')}
          </Row>
          <Row k={t('profile.dataset.checksum')}>
            <span className="font-mono text-[11px]">{ds.manifestSha256.slice(0, 16)}…</span>
          </Row>
        </dl>
        <div>
          <p className="mb-1 font-medium">{t('profile.dataset.coverage')}</p>
          <ul className="space-y-1">
            {COMPONENTS.map(([k, label]) => {
              const c = ds.components[k];
              return (
                <li key={k}>
                  <div className="flex items-center gap-2">
                    <span className="w-32 text-dim">{t(label)}</span>
                    <meter
                      className="h-2 flex-1"
                      min={0}
                      max={c.total}
                      value={c.covered}
                      aria-label={t(label)}
                    />
                    <span className="w-14 text-right font-mono text-muted">
                      {c.covered}/{c.total}
                    </span>
                  </div>
                  {c.missing.length > 0 && (
                    <p className="ml-32 text-warn">
                      {t('profile.dataset.missing', { list: c.missing.map((x) => x || '∅').join(' ') })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          {ds.corpus ? (
            <>
              <p>
                {t('profile.dataset.corpus', {
                  version: ds.corpus.version,
                  covered: ds.corpus.covered,
                  required: ds.corpus.required,
                  pct: ds.corpus.coveragePct,
                })}
              </p>
              {ds.corpus.missing.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted">
                    {t('profile.dataset.corpusMissing')} ({ds.corpus.missing.length})
                  </summary>
                  <p className="mt-1 max-h-32 overflow-auto font-mono text-dim scroll-thin">
                    {ds.corpus.missing.join(' ')}
                  </p>
                </details>
              )}
            </>
          ) : (
            <p className="text-muted">{t('profile.dataset.corpusNone')}</p>
          )}
        </div>
        <div>
          <p className="mb-1 font-medium">{t('profile.dataset.recording')}</p>
          <ul className="space-y-0.5 text-muted">
            <li>
              {t('profile.dataset.format', { rate: r.sampleRate.toLocaleString(lang), sec: r.totalSeconds })}
            </li>
            {r.f0Hz && <li>{t('profile.dataset.f0', { a: r.f0Hz.p10, b: r.f0Hz.median, c: r.f0Hz.p90 })}</li>}
            {r.rmsDbfs && (
              <li>
                {t('profile.dataset.level', { a: r.rmsDbfs.p10, b: r.rmsDbfs.median, c: r.rmsDbfs.p90 })}
              </li>
            )}
            {r.notes && <li>{r.notes}</li>}
          </ul>
        </div>
        {ds.warnings.length > 0 && (
          <div>
            <p className="mb-1 font-medium">{t('profile.dataset.warnings')}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-warn">
              {ds.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {d.datasetHistory.length > 0 && (
          <details>
            <summary className="cursor-pointer text-muted">{t('profile.dataset.history')}</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-dim">
              {d.datasetHistory.map((h) => (
                <li key={h.manifestSha256}>
                  {h.recordedAt.slice(0, 10)} · {h.datasetVersion} · {h.licenseId} ·{' '}
                  {h.manifestSha256.slice(0, 10)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Section>
  );
}

/** "espeak@1.52.0" → "eSpeak NG 1.52.0" (engine id and version as recorded by the server). */
export function engineLabel(recorded: string): string {
  const [id = '', version] = recorded.split('@');
  return `${engineShortName(id)}${version ? ` ${version}` : ''}`;
}
