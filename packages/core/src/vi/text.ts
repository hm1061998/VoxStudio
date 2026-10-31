import { readNumber, spellDigits } from './numbers';
import { PROFILES, type DialectProfile } from './profiles';
import { parseSyllable, type Syllable } from './syllable';

export const VI_LEXICON_VERSION = 'vi-lex-1';

/**
 * Small, conservative lexicon of terms that appear in Vietnamese text but are not Vietnamese
 * syllables. Values are Vietnamese respellings. Anything not listed (and not an acronym) is reported
 * as unresolved, never guessed; users extend this through the pronunciation dictionary.
 */
export const BUILTIN_LEXICON: Record<string, string> = {
  email: 'i meo',
  wifi: 'oai phai',
  'wi-fi': 'oai phai',
  iphone: 'ai phôn',
  facebook: 'phết búc',
  youtube: 'du túp',
  tiktok: 'tích tóc',
  online: 'on lai',
  internet: 'in tơ nét',
  app: 'áp',
  file: 'phai',
  website: 'oép sai',
  zoom: 'du',
  android: 'an đờ roi',
  google: 'gu gồ',
};

/** Letter names used to spell acronyms ("VTV" → "vê tê vê"). */
export const LETTER_NAMES: Record<string, string> = {
  a: 'a',
  b: 'bê',
  c: 'xê',
  d: 'đê',
  đ: 'đê',
  e: 'e',
  f: 'ép',
  g: 'giê',
  h: 'hát',
  i: 'i',
  j: 'gi',
  k: 'ca',
  l: 'eo',
  m: 'em',
  n: 'en',
  o: 'o',
  p: 'pê',
  q: 'quy',
  r: 'e rờ',
  s: 'ét',
  t: 'tê',
  u: 'u',
  v: 'vê',
  w: 'vê kép',
  x: 'ích',
  y: 'i dài',
  z: 'dét',
};

const SYMBOLS: Record<string, string> = {
  '+': 'cộng',
  '=': 'bằng',
  '@': 'a còng',
  '/': 'gạch chéo',
  '*': 'sao',
  '~': 'khoảng',
  '<': 'nhỏ hơn',
  '>': 'lớn hơn',
  '%': 'phần trăm',
  '&': 'và',
  '#': 'thăng',
  _: 'gạch dưới',
  '\\': 'gạch ngược',
  '^': 'mũ',
  '°': 'độ',
};
const CONJUNCTIONS = new Set([
  'và',
  'nhưng',
  'mà',
  'hoặc',
  'hay',
  'vì',
  'nên',
  'thì',
  'rồi',
  'để',
  'khi',
  'nếu',
  'còn',
  'nhưng',
]);
const MAX_PHRASE_SYLLABLES = 12;

export type PhraseType = 'statement' | 'question' | 'exclamation';
export type Boundary = 'none' | 'minor' | 'major' | 'paragraph' | 'end';

export interface SyllableToken {
  syllable: Syllable;
  /** Original written form (before expansion), for diagnostics. */
  surface: string;
  emphasis: boolean;
}

export interface Phrase {
  tokens: SyllableToken[];
  type: PhraseType;
  /** Boundary after this phrase; drives pause length and pre-boundary lengthening. */
  boundary: Boundary;
  /** Terminal punctuation that closed the phrase ("." "?" "!" "…" "," ";" ":" or ""). */
  terminal: string;
}

export interface Analysis {
  phrases: Phrase[];
  /** Tokens that are neither Vietnamese syllables, lexicon entries, acronyms nor numbers. */
  unresolved: string[];
  warnings: string[];
}

export interface AnalyzeOptions {
  profile?: DialectProfile;
  /** User-level lexicon (lower-case key → Vietnamese respelling); takes precedence over the built-in one. */
  userLexicon?: Record<string, string>;
}

type Raw = { kind: 'word' | 'number' | 'punct' | 'newline'; text: string; emphasis: boolean };

function tokenizeRaw(text: string): Raw[] {
  const out: Raw[] = [];
  let emphasis = false;
  const re = /\*|\n+|\d+(?:[.,]\d+)*|[\p{L}\p{M}][\p{L}\p{M}\p{N}'’]*(?:-[\p{L}\p{M}\p{N}]+)*|[^\s]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (t === '*') {
      // `*word*` marks emphasis (documented, Vietnamese engine only); an unpaired star is a symbol.
      const closes = emphasis;
      const hasPair = closes || text.indexOf('*', m.index + 1) > m.index;
      if (hasPair) emphasis = !emphasis;
      else out.push({ kind: 'punct', text: t, emphasis: false });
    } else if (t.startsWith('\n')) out.push({ kind: 'newline', text: t, emphasis: false });
    else if (/^\d/.test(t)) out.push({ kind: 'number', text: t, emphasis });
    else if (/^[\p{L}\p{M}]/u.test(t)) out.push({ kind: 'word', text: t, emphasis });
    else out.push({ kind: 'punct', text: t, emphasis: false });
  }
  return out;
}

const MINOR = new Set([',', ';', ':', '(', ')', '"', '“', '”', '—', '–', '[', ']', '«', '»']);
const MAJOR = new Set(['.', '!', '?', '…']);

/** Rule-based text analysis for Vietnamese synthesis. Deterministic; ambiguity is reported, not resolved by guessing. */
export function analyzeVietnamese(text: string, opts: AnalyzeOptions = {}): Analysis {
  const profile = opts.profile ?? PROFILES.northern;
  const lexicon: Record<string, string> = { ...BUILTIN_LEXICON, ...(opts.userLexicon ?? {}) };
  const raw = tokenizeRaw(text);
  const unresolved: string[] = [];
  const warnings: string[] = [];
  const hasLower = /\p{Ll}/u.test(text);

  const phrases: Phrase[] = [];
  let cur: SyllableToken[] = [];
  const close = (boundary: Boundary, terminal: string) => {
    if (cur.length) {
      const type: PhraseType = terminal === '?' ? 'question' : terminal === '!' ? 'exclamation' : 'statement';
      phrases.push({ tokens: cur, type, boundary, terminal });
      cur = [];
    } else if (phrases.length && boundary !== 'none') {
      const last = phrases[phrases.length - 1]!;
      // Consecutive boundaries (e.g. ".”" or "...") keep the strongest one.
      const rank: Record<Boundary, number> = { none: 0, minor: 1, major: 2, paragraph: 3, end: 3 };
      if (rank[boundary] > rank[last.boundary]) last.boundary = boundary;
      if (terminal && /[?!…]/.test(terminal)) {
        last.terminal = terminal;
        last.type = terminal === '?' ? 'question' : terminal === '!' ? 'exclamation' : last.type;
      }
    }
  };
  const pushWords = (words: string, surface: string, emphasis: boolean): boolean => {
    let ok = true;
    for (const w of words.split(/\s+/).filter(Boolean)) {
      const r = parseSyllable(w);
      if (r.ok) cur.push({ syllable: r.syllable, surface, emphasis });
      else ok = false;
    }
    return ok;
  };
  const spell = (word: string, emphasis: boolean): boolean => {
    let ok = true;
    for (const ch of word.toLowerCase()) {
      const name = LETTER_NAMES[ch] ?? (/\d/.test(ch) ? spellDigits(ch) : null);
      if (name === null) ok = false;
      else pushWords(name, word, emphasis);
    }
    return ok;
  };

  let prevWord = '';
  for (const tok of raw) {
    if (tok.kind === 'number') {
      let words = readNumber(tok.text, profile);
      if (prevWord === 'thứ' && words === 'bốn') words = 'tư';
      pushWords(words, tok.text, tok.emphasis);
      prevWord = '';
    } else if (tok.kind === 'word') {
      const lower = tok.text.toLowerCase();
      const hyphenParts = lower.includes('-') ? lower.split('-') : null;
      const lex = lexicon[lower] ?? lexicon[lower.replace(/-/g, '')];
      const whole = parseSyllable(tok.text);
      const asciiUpper = /^[A-Z]{2,}$/.test(tok.text);
      if (whole.ok && !(asciiUpper && hasLower)) {
        cur.push({ syllable: whole.syllable, surface: tok.text, emphasis: tok.emphasis });
        prevWord = lower;
      } else if (lex !== undefined) {
        if (!pushWords(lex, tok.text, tok.emphasis)) unresolved.push(tok.text);
        prevWord = '';
      } else if (whole.ok) {
        warnings.push(`"${tok.text}" is ambiguous (acronym or word); read as letters.`);
        spell(tok.text, tok.emphasis);
        prevWord = '';
      } else if (hyphenParts && hyphenParts.every((p) => parseSyllable(p).ok)) {
        for (const p of hyphenParts) pushWords(p, tok.text, tok.emphasis);
        prevWord = '';
      } else if (
        /^[A-Za-z]+\d+[A-Za-z\d]*$|^[A-Z][A-Za-zĐ]*$|^[A-ZĐ]{2,}$/.test(tok.text) &&
        /^[A-Za-zĐđ\d]+$/.test(tok.text) &&
        (/\d/.test(tok.text) || /^[A-ZĐ]{2,}[a-z]*$/.test(tok.text) || tok.text.length === 1)
      ) {
        if (!spell(tok.text, tok.emphasis)) unresolved.push(tok.text);
        prevWord = '';
      } else {
        unresolved.push(tok.text);
        prevWord = '';
      }
    } else if (tok.kind === 'newline') close('paragraph', '');
    else {
      const p = tok.text;
      if (MAJOR.has(p)) close('major', p);
      else if (MINOR.has(p)) close('minor', p);
      else if (SYMBOLS[p]) {
        pushWords(SYMBOLS[p]!, p, false);
        prevWord = '';
      }
      // Other punctuation is ignored.
    }
  }
  close('end', '');
  if (phrases.length) {
    const last = phrases[phrases.length - 1]!;
    if (last.boundary === 'none') last.boundary = 'end';
  }
  return { phrases: splitLongPhrases(phrases), unresolved: [...new Set(unresolved)], warnings };
}

/** Break phrases longer than the limit before a conjunction (deterministic), so long text gets breaths. */
function splitLongPhrases(phrases: Phrase[]): Phrase[] {
  const out: Phrase[] = [];
  for (const ph of phrases) {
    let tokens = ph.tokens;
    while (tokens.length > MAX_PHRASE_SYLLABLES) {
      let cut = -1;
      for (let i = 5; i < tokens.length - 3; i++)
        if (CONJUNCTIONS.has(tokens[i]!.syllable.text)) {
          cut = i;
          break;
        }
      if (cut < 0) break;
      out.push({ tokens: tokens.slice(0, cut), type: 'statement', boundary: 'minor', terminal: '' });
      tokens = tokens.slice(cut);
    }
    out.push({ ...ph, tokens });
  }
  return out;
}
