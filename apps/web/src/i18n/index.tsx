import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ParameterCapability, PresetDto, SettingKey, VoiceDto } from '@voxstudio/contracts';
import { en, type MessageKey } from './en';
import { vi } from './vi';

export const LANGUAGES = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'English' },
] as const;
export type Lang = (typeof LANGUAGES)[number]['code'];
const DICTS: Record<Lang, Record<MessageKey, string>> = { en, vi };
const STORAGE_KEY = 'vs-lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'vi' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'vi';
}

// Module-level copy so non-React code (API error mapping, actions) can translate too.
let current: Lang = initialLang();

export type Vars = Record<string, string | number>;
export function translate(key: MessageKey | string, vars?: Vars, lang: Lang = current): string {
  const dict = DICTS[lang] as Record<string, string>;
  let s = dict[key] ?? (en as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
export const hasKey = (key: string): boolean => key in en;
export const currentLang = (): Lang => current;

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = 'VoxStudio';
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    current = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* storage unavailable */
    }
    setLangState(l);
  }, []);
  const value = useMemo<I18n>(
    () => ({ lang, setLang, t: (key, vars) => translate(key, vars, lang) }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside provider');
  return v;
}

// ---- formatting

const intlLocale = (lang: Lang) => (lang === 'vi' ? 'vi-VN' : 'en-US');
export const fmtDate = (iso: string, lang: Lang = current) =>
  new Date(iso).toLocaleString(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' });
export const fmtNumber = (n: number, lang: Lang = current, digits = 1) =>
  n.toLocaleString(intlLocale(lang), { maximumFractionDigits: digits });
export const fmtMs = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
export const fmtBytes = (b: number, lang: Lang = current) =>
  b < 1024
    ? `${b} B`
    : b < 1048576
      ? `${fmtNumber(b / 1024, lang)} KB`
      : `${fmtNumber(b / 1048576, lang)} MB`;

/** Languages that have several regional voices; only these keep the region in their name. */
const REGIONAL = new Set(['en', 'pt', 'es']);
const NAME_OVERRIDES: Record<string, Record<Lang, string>> = {
  'zh-CN': { en: 'Chinese (Mandarin)', vi: 'Tiếng Trung (Quan Thoại)' },
  'yue-HK': { en: 'Chinese (Cantonese)', vi: 'Tiếng Quảng Đông' },
};

/** Language name in the UI language, e.g. vi-VN → "Tiếng Việt" / "Vietnamese"; en-GB → "British English". */
export function languageName(locale: string, lang: Lang = current): string {
  const override = NAME_OVERRIDES[locale]?.[lang];
  if (override) return override;
  const base = locale.split('-')[0]!;
  const tag = REGIONAL.has(base) ? locale : base;
  try {
    const name = new Intl.DisplayNames([intlLocale(lang)], {
      type: 'language',
      languageDisplay: 'dialect',
    }).of(tag);
    if (name) return name.charAt(0).toLocaleUpperCase(intlLocale(lang)) + name.slice(1);
  } catch {
    /* unsupported tag */
  }
  return locale;
}

/** Human voice label in the UI language: language name plus regional accent when known. */
export function voiceLabel(
  v: Pick<VoiceDto, 'locale' | 'accent' | 'displayName'>,
  lang: Lang = current,
): string {
  const name = languageName(v.locale, lang);
  if (v.accent && hasKey(`accent.${v.accent}`))
    return `${languageName(v.locale.split('-')[0]!, lang)} — ${translate(`accent.${v.accent}`, undefined, lang)}`;
  return name === v.locale ? v.displayName : name;
}

export function settingLabel(key: SettingKey, cap?: ParameterCapability): string {
  return hasKey(`setting.${key}.label`) ? translate(`setting.${key}.label`) : (cap?.label ?? key);
}
export function settingDesc(key: SettingKey, cap?: ParameterCapability): string {
  return hasKey(`setting.${key}.desc`) ? translate(`setting.${key}.desc`) : (cap?.description ?? '');
}
export function unitLabel(unit: string): string {
  return hasKey(`unit.${unit}`) ? translate(`unit.${unit}`) : unit;
}
export function variantLabel(value: string, fallback: string): string {
  return hasKey(`variant.${value}`) ? translate(`variant.${value}`) : fallback;
}
export function presetName(p: Pick<PresetDto, 'id' | 'name' | 'isBuiltin'>): string {
  return p.isBuiltin && hasKey(`builtin.${p.id}.name`) ? translate(`builtin.${p.id}.name`) : p.name;
}
export function presetDesc(p: Pick<PresetDto, 'id' | 'description' | 'isBuiltin'>): string {
  return p.isBuiltin && hasKey(`builtin.${p.id}.desc`) ? translate(`builtin.${p.id}.desc`) : p.description;
}
export function tierNote(tier: string): string {
  return tier === 'verified' ? translate('tier.verifiedNote') : translate('tier.experimentalNote');
}

/** Map known server warning sentences (English) to the UI language; unknown ones pass through. */
export function translateWarning(w: string): string {
  const seg = /^Segment (\d+): (.*)$/.exec(w);
  if (seg) return translate('error.paragraph', { n: seg[1]!, msg: translateWarning(seg[2]!) });
  if (w.startsWith('Served from render cache')) return translate('warn.cache');
  let m = /^Exported at (\d+) Hz/.exec(w);
  if (m) return translate('warn.upsample', { rate: fmtNumber(Number(m[1]), current, 0) });
  if (w.startsWith('Stereo export')) return translate('warn.stereo');
  m = /attenuated by ([\d.]+) dB/.exec(w);
  if (m) return translate('warn.attenuated', { db: fmtNumber(Number(m[1])) });
  m = /^(Time stretch|Pitch shift) \(DSP\)/.exec(w);
  if (m)
    return translate('warn.outside', {
      label: settingLabel(m[1] === 'Time stretch' ? 'tempo' : 'pitchShiftSemitones'),
    });
  if (w.startsWith('No VoxStudio normalization rules')) return translate('norm.noRules');
  m = /^Symbols without a normalization rule are passed to the engine unchanged: (.*)$/.exec(w);
  if (m) return translate('norm.symbols', { list: m[1]! });
  return w;
}

/** Regional accent label; falls back to the raw value for accents without a translation. */
export function accentName(accent: string | null, lang: Lang = current): string {
  if (!accent) return '—';
  return hasKey(`accent.${accent}`) ? translate(`accent.${accent}`, undefined, lang) : accent;
}
