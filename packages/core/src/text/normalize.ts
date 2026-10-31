/**
 * Deterministic, locale-specific text normalization (no language models).
 * Rules only rewrite patterns they fully understand; anything else is preserved and the
 * engine's own rule-based number/symbol handling applies. Every rewrite is recorded.
 */
export interface NormalizationStep {
  rule: string;
  from: string;
  to: string;
}

export interface NormalizationResult {
  text: string;
  steps: NormalizationStep[];
  warnings: string[];
}

export const NORMALIZATION_VERSION = 'norm-3';

type Rule = { name: string; re: RegExp; replace: (m: RegExpExecArray) => string | null };

const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const CURRENCY_EN: Record<string, [string, string, string, string]> = {
  $: ['dollar', 'dollars', 'cent', 'cents'],
  '€': ['euro', 'euros', 'cent', 'cents'],
  '£': ['pound', 'pounds', 'penny', 'pence'],
  '¥': ['yen', 'yen', '', ''],
};

function spellUrlPart(s: string): string {
  return s
    .replace(/\./g, ' dot ')
    .replace(/\//g, ' slash ')
    .replace(/-/g, ' dash ')
    .replace(/_/g, ' underscore ')
    .replace(/=/g, ' equals ')
    .replace(/\?/g, ' question mark ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EN_RULES: Rule[] = [
  {
    name: 'url',
    re: /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]]/gi,
    replace: (m) => spellUrlPart(m[0].replace(/^https?:\/\//i, '').replace(/\/$/, '')),
  },
  {
    name: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
    replace: (m) => {
      const [user, domain] = m[0].split('@') as [string, string];
      return `${spellUrlPart(user)} at ${spellUrlPart(domain)}`;
    },
  },
  {
    name: 'iso-date',
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    replace: (m) => {
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return `${MONTHS_EN[month - 1]} ${day}, ${m[1]}`;
    },
  },
  {
    name: 'currency',
    re: /([$€£¥])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d.,]*\d)/g,
    replace: (m) => {
      const names = CURRENCY_EN[m[1]!]!;
      const whole = Number(m[2]!.replace(/,/g, ''));
      const frac = m[3] ? Number(m[3].padEnd(2, '0')) : 0;
      let out = `${whole} ${whole === 1 ? names[0] : names[1]}`;
      if (frac && names[2]) out += ` and ${frac} ${frac === 1 ? names[2] : names[3]}`;
      return out;
    },
  },
  { name: 'percent', re: /(\d+(?:\.\d+)?)\s?%/g, replace: (m) => `${m[1]} percent` },
  {
    name: 'temperature',
    re: /(\d+(?:\.\d+)?)\s?°\s?([CF])\b/g,
    replace: (m) => `${m[1]} degrees ${m[2] === 'C' ? 'Celsius' : 'Fahrenheit'}`,
  },
  { name: 'number-sign', re: /#(\d+)/g, replace: (m) => `number ${m[1]}` },
  { name: 'ampersand', re: /\s&\s/g, replace: () => ' and ' },
  {
    name: 'abbreviation',
    re: /\b(Mr|Mrs|Ms|Dr|Prof|vs|etc|approx)\.(?=\s|$)|\b(e\.g\.|i\.e\.)/g,
    replace: (m) =>
      ({
        Mr: 'Mister',
        Mrs: 'Missus',
        Ms: 'Miz',
        Dr: 'Doctor',
        Prof: 'Professor',
        vs: 'versus',
        etc: 'et cetera',
        approx: 'approximately',
        'e.g.': 'for example',
        'i.e.': 'that is',
      })[(m[1] ?? m[2])!] ?? null,
  },
  { name: 'number-abbreviation', re: /\bNo\.\s?(?=\d)/g, replace: () => 'number ' },
];

// ---- Vietnamese (vi). eSpeak NG already reads digits, "1.000", "15,5" and "%" with Vietnamese
// rules; these rules cover patterns it misreads (dates, times, đồng, units, abbreviations).
const WORD_CHARS = '\\p{L}\\p{N}_';

function spellUrlPartVi(s: string): string {
  return s
    .replace(/\./g, ' chấm ')
    .replace(/\//g, ' gạch chéo ')
    .replace(/-/g, ' gạch ngang ')
    .replace(/_/g, ' gạch dưới ')
    .replace(/\s+/g, ' ')
    .trim();
}
const validDate = (d: number, m: number) => d >= 1 && d <= 31 && m >= 1 && m <= 12;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DIGIT_VI = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
/** Spell digits one by one in Vietnamese, in groups separated by commas (a natural reading rhythm). */
function spellDigitsVi(digits: string, groups: number[]): string {
  const out: string[] = [];
  let i = 0;
  for (const g of groups) {
    out.push([...digits.slice(i, i + g)].map((d) => DIGIT_VI[Number(d)]).join(' '));
    i += g;
  }
  return out.join(', ');
}

/** Roman numeral (I–C) to number; returns null unless it is a canonical numeral. */
function romanToNumber(r: string): number | null {
  if (!/^(C|XC|L?X{0,3})(IX|IV|V?I{0,3})$/.test(r) || !r) return null;
  const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let n = 0;
  for (let i = 0; i < r.length; i++) {
    const cur = v[r[i]!]!;
    n += cur < (v[r[i + 1] ?? ''] ?? 0) ? -cur : cur;
  }
  return n;
}
const ROMAN_CONTEXT = 'thế kỷ|thế chiến|chương|phần|mục|điều|khoản|đại hội|quý';
const NUM = '\\d+(?:[.,]\\d+)?';

const VI_ABBREVIATIONS: Record<string, string> = {
  'TP.HCM': 'Thành phố Hồ Chí Minh',
  'TP. HCM': 'Thành phố Hồ Chí Minh',
  TPHCM: 'Thành phố Hồ Chí Minh',
  'TP.': 'thành phố',
  UBND: 'Ủy ban nhân dân',
  HĐND: 'Hội đồng nhân dân',
  THPT: 'trung học phổ thông',
  THCS: 'trung học cơ sở',
  ĐH: 'đại học',
  'v.v.': 'vân vân',
  'GS.': 'giáo sư',
  'PGS.': 'phó giáo sư',
  'TS.': 'tiến sĩ',
  'ThS.': 'thạc sĩ',
  'BS.': 'bác sĩ',
};
const VI_UNITS: Record<string, string> = {
  'km/h': 'ki lô mét trên giờ',
  km: 'ki lô mét',
  kg: 'ki lô gam',
  cm: 'xen ti mét',
  mm: 'mi li mét',
  'm²': 'mét vuông',
  m2: 'mét vuông',
  ha: 'héc ta',
};
const alternation = (keys: string[]) =>
  keys
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');

const VI_RULES: Rule[] = [
  {
    name: 'url',
    re: /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]]/gi,
    replace: (m) => spellUrlPartVi(m[0].replace(/^https?:\/\//i, '').replace(/\/$/, '')),
  },
  {
    name: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
    replace: (m) => {
      const [user, domain] = m[0].split('@') as [string, string];
      return `${spellUrlPartVi(user)} a còng ${spellUrlPartVi(domain)}`;
    },
  },
  {
    // Vietnamese phone numbers are read digit by digit (the engine would read "345" as a quantity).
    name: 'phone',
    re: /(?<![\d.,/-])(?:\+84|0)[\s.-]?\d(?:[\s.-]?\d){8,9}(?!\d)/g,
    replace: (m) => {
      const intl = m[0].startsWith('+84');
      // Keep the writer's own grouping when there is one ("024 3825 1234"); otherwise use a default.
      const tokens = (intl ? m[0].slice(3) : m[0]).split(/[\s.-]+/).filter(Boolean);
      const digits = tokens.join('');
      const fallback =
        digits.length === 10
          ? [4, 3, 3]
          : digits.length === 11
            ? [4, 4, 3]
            : digits.length === 9
              ? [3, 3, 3]
              : null;
      const groups = tokens.length > 1 ? tokens.map((t) => t.length) : fallback;
      if (!groups || digits.length < 9 || digits.length > 11) return null;
      return [intl ? 'cộng tám bốn' : '', spellDigitsVi(digits, groups)].filter(Boolean).join(', ');
    },
  },
  {
    // "thế kỷ XXI" → "thế kỷ 21" (the engine reads Roman numerals as letters). Context words only.
    name: 'roman',
    re: new RegExp(`(?<![${WORD_CHARS}])(${ROMAN_CONTEXT})\\s+([IVXLC]+)(?![${WORD_CHARS}])`, 'giu'),
    replace: (m) => {
      const n = /^[IVXLC]+$/.test(m[2]!) ? romanToNumber(m[2]!) : null;
      return n === null ? null : `${m[1]} ${n}`;
    },
  },
  {
    name: 'iso-date',
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    replace: (m) =>
      validDate(Number(m[3]), Number(m[2])) ? `ngày ${Number(m[3])} tháng ${Number(m[2])} năm ${m[1]}` : null,
  },
  {
    name: 'date',
    re: /(?<![\d/])(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?![\d/])/g,
    replace: (m) =>
      validDate(Number(m[1]), Number(m[2])) ? `ngày ${Number(m[1])} tháng ${Number(m[2])} năm ${m[3]}` : null,
  },
  {
    // "ngày 3/4" is a date; a bare "3/4" stays a fraction.
    name: 'day-month',
    re: /(ngày|Ngày)\s+(\d{1,2})\/(\d{1,2})(?![\d/])/g,
    replace: (m) =>
      validDate(Number(m[2]), Number(m[3])) ? `${m[1]} ${Number(m[2])} tháng ${Number(m[3])}` : null,
  },
  {
    // "10-20" and "5–7" are ranges: the engine would read them as two adjacent numbers.
    name: 'range',
    re: new RegExp(`(?<![${WORD_CHARS}.,-])(${NUM})\\s?[-–—]\\s?(${NUM})(?![${WORD_CHARS}.,-])`, 'gu'),
    replace: (m) => {
      const a = Number(m[1]!.replace(',', '.'));
      const b = Number(m[2]!.replace(',', '.'));
      return a < b ? `${m[1]} đến ${m[2]}` : null;
    },
  },
  {
    name: 'time',
    re: /(?<![\d:])([01]?\d|2[0-3])(?:h|:)([0-5]\d)(?![\d:])/g,
    replace: (m) => `${Number(m[1])} giờ ${Number(m[2])}`,
  },
  {
    name: 'time',
    re: new RegExp(`(?<![${WORD_CHARS}])([01]?\\d|2[0-3])h(?![${WORD_CHARS}])`, 'gu'),
    replace: (m) => `${Number(m[1])} giờ`,
  },
  { name: 'currency', re: /(\d[\d.,]*)\s?(?:₫|VNĐ|VND|đồng|đ)(?!\p{L})/gu, replace: (m) => `${m[1]} đồng` },
  { name: 'currency', re: /\$\s?(\d[\d.,]*)/g, replace: (m) => `${m[1]} đô la` },
  { name: 'currency', re: /€\s?(\d[\d.,]*)/g, replace: (m) => `${m[1]} ơ rô` },
  { name: 'percent', re: /(\d+(?:[.,]\d+)?)\s?%/g, replace: (m) => `${m[1]} phần trăm` },
  { name: 'temperature', re: /(\d+(?:[.,]\d+)?)\s?°\s?C\b/g, replace: (m) => `${m[1]} độ C` },
  {
    name: 'unit',
    re: new RegExp(`(\\d)\\s?(${alternation(Object.keys(VI_UNITS))})(?![${WORD_CHARS}])`, 'gu'),
    replace: (m) => `${m[1]} ${VI_UNITS[m[2]!]}`,
  },
  { name: 'number-sign', re: /#(\d+)/g, replace: (m) => `số ${m[1]}` },
  { name: 'ampersand', re: /\s&\s/g, replace: () => ' và ' },
  {
    name: 'abbreviation',
    re: new RegExp(
      `(?<![${WORD_CHARS}])(${alternation(Object.keys(VI_ABBREVIATIONS))})(?=$|[^${WORD_CHARS}])`,
      'gu',
    ),
    replace: (m) => VI_ABBREVIATIONS[m[1]!] ?? null,
  },
  { name: 'abbreviation', re: /(?<!\p{L})Q\.\s?(?=\d)/gu, replace: () => 'quận ' },
];

const RULES_BY_LANGUAGE: Record<string, Rule[]> = { en: EN_RULES, vi: VI_RULES };

export function languageOf(locale: string): string {
  return locale.split('-')[0]!.toLowerCase();
}

export function hasLocaleRules(locale: string): boolean {
  return languageOf(locale) in RULES_BY_LANGUAGE;
}

function applyRule(text: string, rule: Rule, steps: NormalizationStep[]): string {
  rule.re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rule.re.exec(text))) {
    const to = rule.replace(m);
    if (to === null) continue;
    out += text.slice(last, m.index) + to;
    last = m.index + m[0].length;
    steps.push({ rule: rule.name, from: m[0], to });
    if (m[0].length === 0) rule.re.lastIndex++;
  }
  return out + text.slice(last);
}

export function normalizeText(input: string, locale: string): NormalizationResult {
  const steps: NormalizationStep[] = [];
  const warnings: string[] = [];
  let text = input.normalize('NFC');
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const rules = RULES_BY_LANGUAGE[languageOf(locale)];
  if (rules) for (const rule of rules) text = applyRule(text, rule, steps);
  else if (/[\d%$€£¥@#&]/.test(text))
    warnings.push(
      `No VoxStudio normalization rules for "${locale}" yet; numbers and symbols are read by eSpeak NG's own language rules.`,
    );
  text = text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  const unhandled = [...new Set(text.match(/[\p{So}\p{Sm}]/gu) ?? [])].filter((c) => !'+-=<>'.includes(c));
  if (unhandled.length)
    warnings.push(
      `Symbols without a normalization rule are passed to the engine unchanged: ${unhandled.join(' ')}`,
    );
  return { text, steps, warnings };
}
