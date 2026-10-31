import { parseSyllable, type Syllable } from './syllable';

/**
 * Regional pronunciation profiles. They drive (a) number words that differ by region, (b) the
 * phoneme transcription shown to users and used for QA, and (c) nothing else: which sounds are actually
 * produced comes from the recorded unit database, whose speaker has a dialect of their own.
 * Status: simplified. Only features cited in the sources read for docs/upgrade are modelled; every
 * other regional difference is deliberately NOT modelled and needs native-speaker review.
 */
export interface DialectProfile {
  id: 'northern' | 'central' | 'southern';
  label: string;
  /** Word for the tens-zero filler ("một trăm linh năm" north, "một trăm lẻ năm" south). */
  zeroTens: 'linh' | 'lẻ';
  thousand: 'nghìn' | 'ngàn';
  onsetIpa: Record<string, string>;
  status: string;
}

const BASE_ONSET: Record<string, string> = {
  '': '',
  b: 'ɓ',
  c: 'k',
  k: 'k',
  q: 'k',
  ch: 'c',
  d: 'z',
  đ: 'ɗ',
  g: 'ɣ',
  gh: 'ɣ',
  gi: 'z',
  h: 'h',
  kh: 'x',
  l: 'l',
  m: 'm',
  n: 'n',
  ng: 'ŋ',
  ngh: 'ŋ',
  nh: 'ɲ',
  p: 'p',
  ph: 'f',
  r: 'z',
  s: 's',
  t: 't',
  th: 'tʰ',
  tr: 'c',
  v: 'v',
  x: 's',
};

export const PROFILES: Record<DialectProfile['id'], DialectProfile> = {
  northern: {
    id: 'northern',
    label: 'Northern (Hà Nội)',
    zeroTens: 'linh',
    thousand: 'nghìn',
    onsetIpa: { ...BASE_ONSET },
    status: 'simplified: onsets only (d/gi/r → z, tr → c, x → s); needs native review',
  },
  central: {
    id: 'central',
    label: 'Central (Huế)',
    zeroTens: 'lẻ',
    thousand: 'ngàn',
    onsetIpa: { ...BASE_ONSET, v: 'j', d: 'j', gi: 'j' },
    status: 'simplified: follows the Southern segmental rule used by vPhon for Central; needs native review',
  },
  southern: {
    id: 'southern',
    label: 'Southern (Sài Gòn)',
    zeroTens: 'lẻ',
    thousand: 'ngàn',
    onsetIpa: { ...BASE_ONSET, v: 'j', d: 'j', gi: 'j' },
    status:
      'simplified: v → j (documented in vPhon README); d/gi → j and number words are common usage; needs native review',
  },
};

const NUCLEUS_IPA: Record<string, string> = {
  a: 'a',
  ă: 'ă',
  â: 'ə̆',
  e: 'ɛ',
  ê: 'e',
  i: 'i',
  y: 'i',
  o: 'ɔ',
  ô: 'o',
  ơ: 'əː',
  u: 'u',
  ư: 'ɯ',
  iê: 'iə',
  yê: 'iə',
  ia: 'iə',
  ya: 'iə',
  ươ: 'ɯə',
  ưa: 'ɯə',
  uô: 'uə',
  ua: 'uə',
};
const CODA_IPA: Record<string, string> = {
  '': '',
  c: 'k',
  ch: 'c',
  m: 'm',
  n: 'n',
  ng: 'ŋ',
  nh: 'ɲ',
  p: 'p',
  t: 't',
  i: 'j',
  y: 'j',
  o: 'w',
  u: 'w',
};
const TONE_NUMBER = { ngang: 1, huyen: 2, sac: 3, hoi: 4, nga: 5, nang: 6 } as const;

export interface Pronunciation {
  /** Phoneme symbols in order: onset, glide, nucleus, coda (empty parts omitted). */
  phonemes: string[];
  ipa: string;
  /** Tone number 1–6 (ngang, huyền, sắc, hỏi, ngã, nặng). */
  toneNumber: number;
}

/** Pronunciation conversion: orthographic syllable → phonemes for a regional profile. */
export function pronounce(s: Syllable, profile: DialectProfile): Pronunciation {
  const onsetKey = s.onset;
  const onset = profile.onsetIpa[onsetKey] ?? '';
  const glide = s.glide ? 'w' : '';
  const nucleus = NUCLEUS_IPA[s.nucleus] ?? s.nucleus;
  const coda = CODA_IPA[s.coda] ?? s.coda;
  const phonemes = [onset, glide, nucleus, coda].filter(Boolean);
  const toneNumber = TONE_NUMBER[s.tone];
  return { phonemes, ipa: `${phonemes.join('')}${toneNumber}`, toneNumber };
}

export function pronounceText(word: string, profile: DialectProfile): Pronunciation | null {
  const r = parseSyllable(word);
  return r.ok ? pronounce(r.syllable, profile) : null;
}
