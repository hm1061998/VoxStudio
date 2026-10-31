import { stripPauseMarkers } from './pauses';

/**
 * Deterministic text splitting. Sentence boundaries use ICU rules via `Intl.Segmenter`
 * (rule-based UAX #29, no statistical models). Source text is preserved verbatim per piece.
 */
export function splitText(text: string, mode: 'paragraph' | 'sentence', locale: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (mode === 'paragraph') return paragraphs;
  const out: string[] = [];
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  } catch {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  }
  for (const p of paragraphs) {
    for (const s of segmenter.segment(p)) {
      const t = s.segment.trim();
      if (t) out.push(t);
    }
  }
  return mergeAbbreviationSplits(out);
}

/** ICU splits after common abbreviations like "Dr." — re-join pieces that end with one. */
const ABBREVIATION_END = /\b(Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|e\.g|i\.e|No|Fig|approx)\.$/i;
function mergeAbbreviationSplits(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBREVIATION_END.test(prev)) out[out.length - 1] = `${prev} ${p}`;
    else out.push(p);
  }
  return out;
}

/** Merge segment texts with a single space (or blank line for paragraphs). */
export function mergeTexts(texts: string[]): string {
  return texts
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

export interface TextStats {
  characters: number;
  words: number;
  /** Estimate only: words ÷ (175 wpm × rate) plus explicit pauses. */
  estimatedMs: number;
}

export function textStats(text: string, rate = 1, extraPauseMs = 0): TextStats {
  const clean = stripPauseMarkers(text);
  const words = clean.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const characters = [...clean.replace(/\s+/g, ' ').trim()].length;
  return { characters, words, estimatedMs: Math.round((words / (175 * rate)) * 60_000) + extraPauseMs };
}
