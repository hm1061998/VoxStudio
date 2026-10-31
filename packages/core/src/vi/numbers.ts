import type { DialectProfile } from './profiles';

const DIGIT = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const GROUP_UNITS = (p: DialectProfile) => ['', p.thousand, 'triệu', 'tỉ', `${p.thousand} tỉ`, 'triệu tỉ'];

export const spellDigits = (digits: string): string =>
  [...digits].map((d) => DIGIT[Number(d)] ?? '').join(' ');

function readGroup(g: number, leading: boolean, p: DialectProfile): string {
  const h = Math.floor(g / 100);
  const t = Math.floor((g % 100) / 10);
  const u = g % 10;
  const out: string[] = [];
  if (h > 0) out.push(DIGIT[h]!, 'trăm');
  else if (!leading && (t > 0 || u > 0)) out.push('không', 'trăm');
  if (t > 1) out.push(DIGIT[t]!, 'mươi');
  else if (t === 1) out.push('mười');
  else if (t === 0 && u > 0 && (h > 0 || !leading)) out.push(p.zeroTens);
  if (u > 0) {
    if (u === 1 && t > 1) out.push('mốt');
    else if (u === 5 && t >= 1) out.push('lăm');
    else out.push(DIGIT[u]!);
  }
  return out.join(' ');
}

/**
 * Read a non-negative integer given as digits. Up to 15 digits are read as a quantity; longer strings
 * and strings with leading zeros (codes, "007") are read digit by digit, never guessed.
 */
export function readInteger(digits: string, p: DialectProfile): string {
  if (!/^\d+$/.test(digits)) throw new Error('digits only');
  if ((digits.length > 1 && digits.startsWith('0')) || digits.length > 15) return spellDigits(digits);
  if (/^0+$/.test(digits)) return 'không';
  const groups: number[] = [];
  for (let end = digits.length; end > 0; end -= 3)
    groups.unshift(Number(digits.slice(Math.max(0, end - 3), end)));
  const units = GROUP_UNITS(p);
  const parts: string[] = [];
  let started = false;
  groups.forEach((g, i) => {
    const level = groups.length - 1 - i;
    if (g === 0) return;
    parts.push(readGroup(g, !started, p), units[level] ?? '');
    started = true;
  });
  return parts.filter(Boolean).join(' ');
}

/**
 * Read a number as written in Vietnamese text: "." groups thousands when followed by exactly three
 * digits ("1.250.000"), "," is the decimal comma ("3,14" → "ba phẩy một bốn"). A "." followed by a
 * different number of digits is treated as a decimal point. Decimal digits are read one by one.
 */
export function readNumber(token: string, p: DialectProfile): string {
  let intPart = token;
  let frac = '';
  const comma = token.indexOf(',');
  if (comma >= 0) {
    intPart = token.slice(0, comma);
    frac = token.slice(comma + 1);
  } else if (/^\d+\.\d+$/.test(token) && !/^\d{1,3}(\.\d{3})+$/.test(token)) {
    const dot = token.indexOf('.');
    intPart = token.slice(0, dot);
    frac = token.slice(dot + 1);
  }
  if (/^\d{1,3}(\.\d{3})+$/.test(intPart)) intPart = intPart.replace(/\./g, '');
  if (!/^\d+$/.test(intPart) || (frac && !/^\d+$/.test(frac))) return spellDigits(token.replace(/\D/g, ''));
  const whole = readInteger(intPart, p);
  return frac ? `${whole} phẩy ${spellDigits(frac)}` : whole;
}
