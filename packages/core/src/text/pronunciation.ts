import { createHash } from 'node:crypto';
import { languageOf } from './normalize';

export interface PronunciationRule {
  id: string;
  locale: string;
  matchText: string;
  replacementText: string;
  phonemeFormat: 'espeak' | null;
  engineScope: string | null;
  caseSensitive: boolean;
  wholeWord: boolean;
  priority: number;
  enabled: boolean;
  /** ISO timestamp; final tie-breaker together with id. */
  createdAt: string;
}

/** Entry locale `en` applies to `en-US`; `en-US` applies only to `en-US`. */
export function ruleAppliesTo(rule: PronunciationRule, locale: string, engineId: string): boolean {
  if (!rule.enabled) return false;
  if (rule.engineScope && rule.engineScope !== engineId) return false;
  const r = rule.locale.toLowerCase();
  const l = locale.toLowerCase();
  return r === l || (!r.includes('-') && r === languageOf(l));
}

/**
 * Deterministic precedence: higher priority, then longer match, then case-sensitive,
 * then more specific locale, then oldest, then id.
 */
export function comparePrecedence(a: PronunciationRule, b: PronunciationRule): number {
  return (
    b.priority - a.priority ||
    [...b.matchText].length - [...a.matchText].length ||
    Number(b.caseSensitive) - Number(a.caseSensitive) ||
    Number(b.locale.includes('-')) - Number(a.locale.includes('-')) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Literal matcher (user input is never compiled as a regex pattern). */
function matcher(rule: PronunciationRule): RegExp {
  const body = escapeRegExp(rule.matchText);
  const src = rule.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(src, rule.caseSensitive ? 'gu' : 'giu');
}

export interface PronunciationMatch {
  ruleId: string;
  start: number;
  end: number;
}

/**
 * Find non-overlapping matches in one pass over the original text. Overlaps are resolved by
 * precedence, so the result never depends on the order entries were stored in.
 */
export function findPronunciationMatches(text: string, rules: PronunciationRule[]): PronunciationMatch[] {
  const ordered = [...rules].sort(comparePrecedence);
  const taken: PronunciationMatch[] = [];
  for (const rule of ordered) {
    for (const m of text.matchAll(matcher(rule))) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) continue;
      if (taken.some((t) => start < t.end && end > t.start)) continue;
      taken.push({ ruleId: rule.id, start, end });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** Private-use placeholders survive normalization untouched. */
const PLACEHOLDER_BASE = 0xe000;
export function placeholder(i: number): string {
  return String.fromCodePoint(PLACEHOLDER_BASE + i);
}

export interface PlaceholderResult {
  text: string;
  /** Placeholder index → rule id */
  slots: string[];
}

export function insertPlaceholders(text: string, matches: PronunciationMatch[]): PlaceholderResult {
  let out = '';
  let last = 0;
  const slots: string[] = [];
  for (const m of matches) {
    out += text.slice(last, m.start) + ` ${placeholder(slots.length)} `;
    slots.push(m.ruleId);
    last = m.end;
  }
  return { text: out + text.slice(last), slots };
}

export function restorePlaceholders(
  text: string,
  slots: string[],
  render: (ruleId: string) => string,
): string {
  return text.replace(/[-]/g, (c) => {
    const id = slots[(c.codePointAt(0) ?? 0) - PLACEHOLDER_BASE];
    return id ? render(id) : '';
  });
}

export interface PronunciationConflict {
  locale: string;
  matchText: string;
  entryIds: string[];
  winnerId: string;
}

/** Entries with the same locale + match text (case-folded unless case-sensitive) conflict. */
export function detectConflicts(rules: PronunciationRule[]): PronunciationConflict[] {
  const groups = new Map<string, PronunciationRule[]>();
  for (const r of rules.filter((x) => x.enabled)) {
    const key = `${r.locale.toLowerCase()}\u0000${r.engineScope ?? ''}\u0000${r.caseSensitive ? r.matchText : r.matchText.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: PronunciationConflict[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(comparePrecedence);
    out.push({
      locale: sorted[0]!.locale,
      matchText: sorted[0]!.matchText,
      entryIds: sorted.map((r) => r.id),
      winnerId: sorted[0]!.id,
    });
  }
  return out;
}

/**
 * Deterministic revision of a pronunciation dictionary: a SHA-256 over the enabled entries'
 * pronunciation-affecting fields, independent of storage order and timestamps. Identical dictionaries
 * have identical revisions, so exports can be compared and render caches stay correct.
 */
export function dictionaryRevision(rules: PronunciationRule[]): string {
  const entries = rules
    .filter((r) => r.enabled)
    .map((r) => [
      r.locale,
      r.engineScope ?? '',
      r.matchText,
      r.replacementText,
      r.phonemeFormat ?? '',
      r.caseSensitive,
      r.wholeWord,
      r.priority,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return `dict-${createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)}`;
}
