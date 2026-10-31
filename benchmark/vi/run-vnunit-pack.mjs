#!/usr/bin/env node
// Renders the Vietnamese benchmark with a recorded-unit database (vnunit) and writes a listening pack that sets
// it beside the eSpeak NG baseline (and, if present, an AI whole-sentence reference made at development time).
// Usage: node benchmark/vi/run-vnunit-pack.mjs <unitDbDir> [--out qa-output/vnunit-pack] [--reference <dir>]
// Objective measurements only. Ratings stay blank: only listeners can judge naturalness or tone correctness.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import core from '../../packages/core/dist/index.js';
import { BENCHMARK_VERSION, SENTENCES } from './sentences.mjs';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const dbDir = process.argv[2];
if (!dbDir || dbDir.startsWith('--')) {
  console.error('usage: node benchmark/vi/run-vnunit-pack.mjs <unitDbDir> [--out dir] [--reference dir]');
  process.exit(2);
}
const out = path.resolve(arg('--out', 'qa-output/vnunit-pack'));
const refDir = arg('--reference', null);
const espeakDir = path.resolve('qa-output/sample-pack/voices');
const db = core.UnitDb.load(path.resolve(dbDir));
const sha = (b) => createHash('sha256').update(b).digest('hex');
for (const d of ['vnunit', 'espeak', 'ai-reference']) mkdirSync(path.join(out, d), { recursive: true });

const rows = [];
const perCategory = [];
for (const s of SENTENCES) if (!perCategory.some((x) => x.category === s.category)) perCategory.push(s);
const chosen = new Set(perCategory.map((s) => s.id));

for (const s of SENTENCES) {
  // Same text preparation as the application (normalization + dictionary) before the engine sees it.
  const prepared = core.prepareEngineText(s.text, 'vi-VN', 'vnunit', []);
  const text = prepared.chunks
    .filter((c) => c.kind === 'speech')
    .map((c) => c.text)
    .join(' ');
  const t0 = performance.now();
  try {
    const r = core.synthesizeVietnamese(db, text);
    const wallMs = performance.now() - t0;
    const wav = core.encodeWavPcm16(r.samples, 22050, 1).wav;
    if (chosen.has(s.id)) writeFileSync(path.join(out, 'vnunit', `${s.id}-vnunit.wav`), wav);
    rows.push({
      id: s.id,
      category: s.category,
      ok: true,
      audioMs: r.durationMs,
      wallMs: Math.round(wallMs),
      rtf: Number((wallMs / r.durationMs).toFixed(3)),
      syllables: r.metrics.syllables,
      joins: r.metrics.joins,
      incompatibleJoins: r.metrics.incompatibleJoins,
      maxJoinF0JumpSt: r.metrics.maxJoinF0JumpSt,
      maxDiscontinuity: r.metrics.maxDiscontinuity,
      sha: sha(wav).slice(0, 16),
    });
  } catch (e) {
    rows.push({
      id: s.id,
      category: s.category,
      ok: false,
      error: e.code ?? e.message,
      detail: String(e.message).slice(0, 160),
    });
  }
}

const copied = [];
for (const s of perCategory) {
  const e = path.join(espeakDir, `${s.id}-northern.wav`);
  if (existsSync(e)) {
    copyFileSync(e, path.join(out, 'espeak', `${s.id}-espeak-northern.wav`));
    copied.push(s.id);
  }
  if (refDir) {
    const r = path.resolve(refDir, `${s.id}-ai-reference.wav`);
    if (existsSync(r)) copyFileSync(r, path.join(out, 'ai-reference', `${s.id}-ai-reference.wav`));
  }
}

const ok = rows.filter((r) => r.ok);
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const failures = {};
for (const r of rows.filter((x) => !x.ok)) failures[r.error] = (failures[r.error] ?? 0) + 1;
const summary = {
  benchmark: BENCHMARK_VERSION,
  database: {
    id: db.manifest.id,
    units: db.units.length,
    provenance: db.manifest.provenance?.kind ?? 'unknown',
  },
  sentences: SENTENCES.length,
  rendered: ok.length,
  failedByCode: failures,
  medianRtf: ok.length ? med(ok.map((r) => r.rtf)) : null,
  incompatibleJoinsTotal: ok.reduce((a, r) => a + r.incompatibleJoins, 0),
  joinsTotal: ok.reduce((a, r) => a + r.joins, 0),
  medianMaxDiscontinuity: ok.length ? med(ok.map((r) => r.maxDiscontinuity)) : null,
  maxDiscontinuityOverall: ok.length ? Math.max(...ok.map((r) => r.maxDiscontinuity)) : null,
};
writeFileSync(path.join(out, 'results.json'), JSON.stringify({ summary, rows }, null, 2));

const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const BOM = String.fromCharCode(0xfeff);
const header = [
  'sentence',
  'category',
  'system',
  'file',
  'text',
  'pronunciation_1to5',
  'tone_correctness_1to5',
  'syllable_transitions_1to5',
  'natural_pauses_1to5',
  'sentence_intonation_1to5',
  'intelligibility_1to5',
  'artifacts_1to5_5=none',
  'overall_naturalness_1to5',
  'notes',
];
const lines = [];
for (const s of perCategory)
  for (const [system, dir, suffix] of [
    ['espeak-northern', 'espeak', 'espeak-northern'],
    ['vnunit', 'vnunit', 'vnunit'],
    ['ai-reference', 'ai-reference', 'ai-reference'],
  ]) {
    const f = path.join(dir, `${s.id}-${suffix}.wav`);
    if (existsSync(path.join(out, f)))
      lines.push([s.id, s.category, system, f, s.text].map(q).join(',') + ',,,,,,,,,');
  }
writeFileSync(path.join(out, 'listening-sheet.csv'), `${BOM}${header.join(',')}\n${lines.join('\n')}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`${lines.length} files in the listening sheet (${out})`);
