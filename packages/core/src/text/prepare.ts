import { espeakPhonemeSpan, sanitizeEspeakText } from '../engine/espeak';
import { normalizeText, type NormalizationStep } from './normalize';
import { splitPauses } from './pauses';
import {
  findPronunciationMatches,
  insertPlaceholders,
  restorePlaceholders,
  ruleAppliesTo,
  type PronunciationRule,
} from './pronunciation';

export type EngineChunk = { kind: 'speech'; text: string } | { kind: 'pause'; pauseMs: number };

export interface PreparedText {
  /** Normalized text with pronunciation replacements shown in plain form (for display). */
  normalized: string;
  chunks: EngineChunk[];
  steps: NormalizationStep[];
  warnings: string[];
  applied: { entryId: string; matchText: string; count: number }[];
}

/**
 * Source text → engine-ready chunks. Order: pause markers → pronunciation matching on the
 * original text (placeholders) → locale normalization → engine sanitization → substitution.
 * Deterministic for identical inputs and rule sets.
 */
export function prepareEngineText(
  sourceText: string,
  locale: string,
  engineId: string,
  allRules: PronunciationRule[],
): PreparedText {
  const rules = allRules.filter((r) => ruleAppliesTo(r, locale, engineId));
  const byId = new Map(rules.map((r) => [r.id, r]));
  const chunks: EngineChunk[] = [];
  const steps: NormalizationStep[] = [];
  const warnings = new Set<string>();
  const counts = new Map<string, number>();
  const display: string[] = [];

  for (const chunk of splitPauses(sourceText)) {
    if (chunk.kind === 'pause') {
      chunks.push(chunk);
      display.push(`[pause ${chunk.pauseMs}ms]`);
      continue;
    }
    const matches = findPronunciationMatches(chunk.text, rules);
    for (const m of matches) counts.set(m.ruleId, (counts.get(m.ruleId) ?? 0) + 1);
    const { text: withSlots, slots } = insertPlaceholders(chunk.text, matches);
    const norm = normalizeText(withSlots, locale);
    steps.push(...norm.steps);
    norm.warnings.forEach((w) => warnings.add(w));
    const engineText = restorePlaceholders(sanitizeEspeakText(norm.text), slots, (id) => {
      const r = byId.get(id)!;
      return r.phonemeFormat === 'espeak'
        ? espeakPhonemeSpan(r.replacementText)
        : sanitizeEspeakText(r.replacementText);
    });
    const shown = restorePlaceholders(norm.text, slots, (id) => {
      const r = byId.get(id)!;
      return r.phonemeFormat === 'espeak' ? `/${r.replacementText}/` : r.replacementText;
    });
    const clean = engineText.replace(/\s+/g, ' ').trim();
    if (clean) {
      chunks.push({ kind: 'speech', text: clean });
      display.push(shown.replace(/\s+/g, ' ').trim());
    }
  }
  return {
    normalized: display.join(' '),
    chunks,
    steps,
    warnings: [...warnings],
    applied: [...counts].map(([entryId, count]) => ({
      entryId,
      matchText: byId.get(entryId)!.matchText,
      count,
    })),
  };
}
