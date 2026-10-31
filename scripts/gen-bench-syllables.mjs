#!/usr/bin/env node
// Derives the tonal syllables needed to read the versioned Vietnamese benchmark (benchmark/vi/sentences.mjs)
// and writes config/vi-bench-syllables.json. Dataset coverage reports compare unit databases against it.
// Usage: pnpm build && node scripts/gen-bench-syllables.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import core from '../packages/core/dist/index.js';
import { BENCHMARK_VERSION, SENTENCES, TONE_SETS } from '../benchmark/vi/sentences.mjs';

const root = path.resolve(import.meta.dirname, '..');
const set = new Set();
const unresolved = new Set();
for (const syl of TONE_SETS.flat()) set.add(core.parseSyllable(syl).syllable?.text ?? syl);
for (const s of SENTENCES) {
  // Same preparation as the application (normalization turns abbreviations and units into words) before analysis.
  const prepared = core.prepareEngineText(s.text, 'vi-VN', 'vnunit', []);
  const a = core.analyzeVietnamese(
    prepared.chunks
      .filter((c) => c.kind === 'speech')
      .map((c) => c.text)
      .join(' '),
  );
  for (const p of a.phrases) for (const t of p.tokens) set.add(t.syllable.text);
  for (const u of a.unresolved) unresolved.add(u);
}
const syllables = [...set].sort((a, b) => a.localeCompare(b, 'vi'));
const body = {
  corpusVersion: BENCHMARK_VERSION,
  sentences: SENTENCES.length,
  syllables,
  unresolvedTokens: [...unresolved].sort(),
  sha256: createHash('sha256').update(JSON.stringify(syllables)).digest('hex'),
};
writeFileSync(path.join(root, 'config', 'vi-bench-syllables.json'), `${JSON.stringify(body, null, 2)}\n`);
console.log(`${BENCHMARK_VERSION}: ${syllables.length} syllables from ${SENTENCES.length} sentences`);
