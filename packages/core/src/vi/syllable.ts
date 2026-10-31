// Deterministic Vietnamese syllable analysis from orthography (quốc ngữ). Rule-based; no learned models.
// Structure: [onset] [medial glide] nucleus [coda] + tone. Orthographic rules are applied strictly:
// a string that is not a well-formed Vietnamese syllable is reported as such, never guessed.

export const TONES = ['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang'] as const;
export type Tone = (typeof TONES)[number];

export interface Syllable {
  /** Normalised key: lower-case NFC, tone mark included (e.g. "chào"). */
  text: string;
  /** Orthographic onset ("" for zero onset; "q" for "qu"). */
  onset: string;
  /** Medial glide letter ("o" or "u") or "". For "qu" the glide is "u". */
  glide: string;
  nucleus: string;
  coda: string;
  tone: Tone;
}

export type ParseResult = { ok: true; syllable: Syllable } | { ok: false; reason: string };

const TONE_MARK: Record<string, Tone> = {
  '̀': 'huyen',
  '́': 'sac',
  '̉': 'hoi',
  '̃': 'nga',
  '̣': 'nang',
};
const VOWELS = new Set(['a', 'ă', 'â', 'e', 'ê', 'i', 'y', 'o', 'ô', 'ơ', 'u', 'ư']);
const ONSETS = [
  'ngh',
  'ng',
  'nh',
  'ph',
  'th',
  'tr',
  'ch',
  'kh',
  'gh',
  'gi',
  'qu',
  'b',
  'c',
  'd',
  'đ',
  'g',
  'h',
  'k',
  'l',
  'm',
  'n',
  'p',
  'q',
  'r',
  's',
  't',
  'v',
  'x',
];
const FRONT = new Set(['e', 'ê', 'i', 'y']);
const NUCLEUS = /^(iê|yê|ươ|uô|ia|ya|ưa|ua|a|ă|â|e|ê|i|y|o|ô|ơ|u|ư)(ch|ng|nh|c|m|n|p|t|i|y|o|u)?$/;
const OPEN_ONLY = new Set(['ia', 'ya', 'ưa', 'ua']);
const STOPS = new Set(['c', 'ch', 'p', 't']);

/** Split a tone mark off a syllable; returns null when more than one tone mark is present. */
export function splitTone(raw: string): { base: string; tone: Tone } | null {
  const nfd = raw.normalize('NFD');
  let tone: Tone = 'ngang';
  let found = 0;
  let base = '';
  for (const ch of nfd) {
    const t = TONE_MARK[ch];
    if (t) {
      tone = t;
      found++;
    } else base += ch;
  }
  return found > 1 ? null : { base: base.normalize('NFC'), tone };
}

export function parseSyllable(raw: string): ParseResult {
  const text = raw.toLowerCase().normalize('NFC');
  if (!text || /[^\p{L}\p{M}]/u.test(text)) return { ok: false, reason: 'not-letters' };
  const split = splitTone(text);
  if (!split) return { ok: false, reason: 'multiple-tone-marks' };
  const { base, tone } = split;
  if (/[^a-zăâêôơưđ]/.test(base)) return { ok: false, reason: 'non-vietnamese-letter' };

  let onset = '';
  let rest = base;
  let glide = '';
  for (const o of ONSETS)
    if (base.startsWith(o)) {
      onset = o;
      rest = base.slice(o.length);
      break;
    }
  if (onset === 'gi') {
    // "gi" is an onset before a vowel; otherwise its "i" is the nucleus (gì, gin).
    if (!rest || !VOWELS.has(rest[0] ?? '')) rest = `i${rest}`;
  } else if (onset === 'qu') {
    onset = 'q';
    glide = 'u';
  } else if (onset === 'q') return { ok: false, reason: 'q-without-u' };
  const first = rest[0] ?? '';
  const needsFront = FRONT.has(first);
  if (onset === 'c' && needsFront) return { ok: false, reason: 'spelling:c-before-front-vowel' };
  // "k" before back vowels occurs in place and ethnic-minority names (Mê Kông, Kon Tum): accepted.
  if ((onset === 'g' || onset === 'ng') && needsFront)
    return { ok: false, reason: `spelling:${onset}-before-front-vowel` };
  if ((onset === 'gh' || onset === 'ngh') && !needsFront)
    return { ok: false, reason: `spelling:${onset}-before-back-vowel` };

  if (!glide) {
    const next = rest[1] ?? '';
    if (first === 'o' && ['a', 'ă', 'e'].includes(next)) glide = 'o';
    else if (first === 'u') {
      const closedUa = next === 'a' && rest.length > 2;
      if (['â', 'y', 'ê', 'ơ', 'ă'].includes(next) || closedUa) glide = 'u';
    }
    if (glide) rest = rest.slice(1);
  }
  const m = NUCLEUS.exec(rest);
  if (!m) return { ok: false, reason: 'no-valid-nucleus-coda' };
  const nucleus = m[1] ?? '';
  const coda = m[2] ?? '';
  if (OPEN_ONLY.has(nucleus) && coda) return { ok: false, reason: 'diphthong-with-coda' };
  if (STOPS.has(coda) && tone !== 'sac' && tone !== 'nang')
    return { ok: false, reason: 'stop-coda-requires-sac-or-nang' };
  return { ok: true, syllable: { text, onset, glide, nucleus, coda, tone } };
}

export const isVietnameseSyllable = (s: string): boolean => parseSyllable(s).ok;

/** Tone of a syllable written with its diacritics (null when the string is not a Vietnamese syllable). */
export function identifyTone(s: string): Tone | null {
  const r = parseSyllable(s);
  return r.ok ? r.syllable.tone : null;
}
