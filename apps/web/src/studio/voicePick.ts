import type { VoiceDto } from '@voxstudio/contracts';

export type Gender = 'female' | 'male';
export interface VoiceWish {
  /** Regional accent to require; undefined = do not care. */
  accent?: string | null;
  /** Speaker gender to require; undefined = do not care. */
  gender?: Gender | null;
}

const sameLanguageLocale = (a: VoiceDto, b: VoiceDto) => a.locale === b.locale;

const ACCENT_ORDER = ['northern', 'central', 'southern'];

/**
 * The voice offered first for a language: Northern before Central before Southern, female before male, then by name.
 * Used wherever a screen needs a voice before the user has chosen one; it never names an engine.
 */
export function defaultVoiceFor(voices: VoiceDto[], locale: string): VoiceDto | undefined {
  const lang = locale.split('-')[0]!.toLowerCase();
  const list = voices.filter((v) => v.locale === locale || v.locale.split('-')[0]!.toLowerCase() === lang);
  const rank = (v: VoiceDto) => {
    const a = ACCENT_ORDER.indexOf(v.accent ?? '');
    return a < 0 ? ACCENT_ORDER.length : a;
  };
  return [...list].sort(
    (a, b) =>
      Number(b.locale === locale) - Number(a.locale === locale) ||
      rank(a) - rank(b) ||
      Number(b.gender === 'female') - Number(a.gender === 'female') ||
      a.displayName.localeCompare(b.displayName),
  )[0];
}

/** Accents offered for a locale, optionally only those that exist for the given gender. Sorted, no duplicates. */
export function availableAccents(voices: VoiceDto[], locale: string, gender?: Gender | null): string[] {
  return [
    ...new Set(
      voices
        .filter((v) => v.locale === locale && (!gender || v.gender === gender))
        .map((v) => v.accent)
        .filter((a): a is string => !!a),
    ),
  ].sort();
}

/** Genders offered for a locale, optionally only those that exist for the given accent. Never invents one. */
export function availableGenders(voices: VoiceDto[], locale: string, accent?: string | null): Gender[] {
  const found = new Set(
    voices
      .filter((v) => v.locale === locale && (!accent || v.accent === accent))
      .map((v) => v.gender)
      .filter((g): g is Gender => g === 'female' || g === 'male'),
  );
  return (['female', 'male'] as const).filter((g) => found.has(g));
}

/**
 * Choose the voice that satisfies a wish. Among matches the current voice wins, then a voice of the same engine
 * (so a choice of accent or gender does not switch engine without need), then the first by name.
 * Returns undefined when nothing matches: callers must say so instead of silently picking another voice.
 */
export function pickVoice(voices: VoiceDto[], current: VoiceDto, wish: VoiceWish): VoiceDto | undefined {
  const matches = voices.filter(
    (v) =>
      sameLanguageLocale(v, current) &&
      (wish.accent === undefined || v.accent === wish.accent) &&
      (wish.gender === undefined || v.gender === wish.gender),
  );
  return [...matches].sort(
    (a, b) =>
      Number(b.id === current.id) - Number(a.id === current.id) ||
      Number(b.engineId === current.engineId) - Number(a.engineId === current.engineId) ||
      a.displayName.localeCompare(b.displayName),
  )[0];
}
