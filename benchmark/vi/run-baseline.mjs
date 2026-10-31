#!/usr/bin/env node
// Reproducible Vietnamese baseline for the installed eSpeak NG (docs/upgrade/03-VIETNAMESE-BENCHMARK.md).
// Usage: pnpm build && node benchmark/vi/run-baseline.mjs [--audio <dir>]
// Writes benchmark/vi/results/<engine>-<version>.json and prints summary tables.
// Only objective measurements are produced. It does NOT score naturalness or intelligibility:
// those require human listeners and are reported as "not measured".
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import core from '../../packages/core/dist/index.js';
import { BENCHMARK_VERSION, SENTENCES, TONE_NAMES, TONE_SETS } from './sentences.mjs';
import { contourDistance, contourFeatures, trackF0 } from './f0.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const audioDir = process.argv.includes('--audio') ? process.argv[process.argv.indexOf('--audio') + 1] : null;
const config = core.loadConfig();
const adapter = new core.EspeakAdapter({
  executable: config.tools.espeak,
  approvedVersion: config.espeakApprovedVersion,
});
const version = await adapter.detectVersion();
await adapter.initialize();
const ffmpegVersion = (await core.assertFfmpegCompliant(config.tools.ffmpeg)).version;
const VOICES = [
  ['vi', 'northern'],
  ['vi-vn-x-central', 'central'],
  ['vi-vn-x-south', 'southern'],
];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Edit distance between phoneme-token sequences. */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const tokens = (m) =>
  m
    .replace(/_\|/g, ' ')
    .split(/[\s']+/)
    .filter(Boolean);

const results = {
  benchmark: BENCHMARK_VERSION,
  engine: { id: 'espeak', version },
  ffmpeg: ffmpegVersion,
  generatedAt: new Date().toISOString(),
  sentenceCount: SENTENCES.length,
  voices: {},
  dialect: {},
  notMeasured: [
    'naturalness (MOS)',
    'intelligibility',
    'prosody quality',
    'pronunciation accuracy by native listeners',
  ],
};

await core.withTempDir(config.tempDir, 'bench', async (dir) => {
  const ctx = { tempDir: dir, timeoutMs: 60_000 };
  const mnemonics = {};
  for (const [voice, label] of VOICES) {
    const caps = adapter.getCapabilities(voice);
    const settings = core.defaultSettings(caps);
    const rows = [];
    for (const s of SENTENCES) {
      const prepared = core.prepareEngineText(s.text, 'vi-VN', 'espeak', []);
      const spoken = prepared.chunks
        .filter((c) => c.kind === 'speech')
        .map((c) => c.text)
        .join(' ');
      const t0 = performance.now();
      let r1;
      try {
        r1 = await core.synthesizeSegment({
          chunks: prepared.chunks,
          nativeVoiceId: voice,
          settings,
          capabilities: caps,
          adapter,
          ffmpeg: config.tools.ffmpeg,
          ffmpegVersion,
          tempDir: dir,
          timeoutMs: 60_000,
        });
      } catch (e) {
        rows.push({ id: s.id, category: s.category, ok: false, error: e.code ?? e.message });
        continue;
      }
      const wallMs = performance.now() - t0;
      // Determinism: a second identical render must be byte-identical.
      const r2 = await core.synthesizeSegment({
        chunks: prepared.chunks,
        nativeVoiceId: voice,
        settings,
        capabilities: caps,
        adapter,
        ffmpeg: config.tools.ffmpeg,
        ffmpegVersion,
        tempDir: dir,
        timeoutMs: 60_000,
      });
      const { samples } = core.decodeWavToFloat(r1.wav);
      const mn = await adapter.mnemonics(spoken, voice, ctx);
      mnemonics[`${label}:${s.id}`] = mn;
      // eSpeak marks words read with another language's rules as "(xx)word(vi)".
      const switches = [...mn.matchAll(/\(([a-z]{2,3}(?:-[a-z0-9]+)*)\)/gi)]
        .map((m) => m[1].toLowerCase())
        .filter((l) => l !== 'vi' && !l.startsWith('vi-'));
      rows.push({
        id: s.id,
        category: s.category,
        ok: true,
        audioMs: r1.durationMs,
        wallMs: Math.round(wallMs),
        rtf: Number((wallMs / r1.durationMs).toFixed(3)),
        deterministic: sha(r1.wav) === sha(r2.wav),
        rms: Number(core.rms(samples).toFixed(4)),
        peak: Number(core.peakAbs(samples).toFixed(3)),
        foreignSwitches: switches.length,
        words: spoken.split(/\s+/).filter(Boolean).length,
        hash: sha(r1.wav).slice(0, 16),
      });
      if (audioDir && label === 'northern') {
        mkdirSync(audioDir, { recursive: true });
        writeFileSync(path.join(audioDir, `${s.id}-${label}.wav`), r1.wav);
      }
    }
    const ok = rows.filter((r) => r.ok);
    const cat = {};
    for (const r of ok) (cat[r.category] ??= []).push(r);
    results.voices[label] = {
      nativeId: voice,
      rendered: ok.length,
      failed: rows.length - ok.length,
      deterministic: ok.filter((r) => r.deterministic).length,
      silentOrClipped: ok.filter((r) => r.rms < 0.005 || r.peak >= 0.999).length,
      sentencesWithForeignSwitch: ok.filter((r) => r.foreignSwitches > 0).length,
      medianRtf: median(ok.map((r) => r.rtf)),
      maxRtf: Math.max(...ok.map((r) => r.rtf)),
      totalAudioSec: Number((ok.reduce((n, r) => n + r.audioMs, 0) / 1000).toFixed(1)),
      byCategory: Object.fromEntries(
        Object.entries(cat).map(([k, v]) => [
          k,
          {
            n: v.length,
            medianAudioMs: median(v.map((r) => r.audioMs)),
            foreign: v.filter((r) => r.foreignSwitches > 0).length,
          },
        ]),
      ),
      failures: rows.filter((r) => !r.ok),
      foreignSentences: ok.filter((r) => r.foreignSwitches > 0).map((r) => r.id),
    };
  }

  // Dialect difference: do the three voices actually differ, and by how much (phoneme-token edit distance)?
  for (const [a, b] of [
    ['northern', 'central'],
    ['northern', 'southern'],
    ['central', 'southern'],
  ]) {
    let differing = 0;
    let dist = 0;
    let toks = 0;
    for (const s of SENTENCES) {
      const ma = mnemonics[`${a}:${s.id}`];
      const mb = mnemonics[`${b}:${s.id}`];
      if (ma === undefined || mb === undefined) continue;
      const ta = tokens(ma);
      const tb = tokens(mb);
      if (ma !== mb) differing++;
      dist += editDistance(ta, tb);
      toks += Math.max(ta.length, tb.length);
    }
    results.dialect[`${a}-vs-${b}`] = {
      sentencesDiffering: differing,
      of: SENTENCES.length,
      tokenEditRate: Number((dist / toks).toFixed(3)),
    };
  }

  // Tone contours: isolated syllables, raw engine output (no DSP), F0 measured on the audio.
  results.tones = {};
  for (const [voice, label] of VOICES) {
    const caps = adapter.getCapabilities(voice);
    const settings = core.defaultSettings(caps);
    const perTone = TONE_NAMES.map(() => []);
    for (const set of TONE_SETS)
      for (let t = 0; t < 6; t++) {
        const out = await adapter.synthesize({ text: set[t], nativeVoiceId: voice, settings }, ctx);
        const { samples, info } = core.decodeWavToFloat(readFileSync(out.filePath));
        const f = contourFeatures(trackF0(samples, info.sampleRate));
        if (f) perTone[t].push({ syllable: set[t], ...f });
      }
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const summary = perTone.map((rows, t) => ({
      tone: TONE_NAMES[t],
      measured: rows.length,
      of: TONE_SETS.length,
      voicedMs: Math.round(mean(rows.map((r) => r.voicedMs))),
      points: [0, 1, 2, 3, 4].map((i) => Number(mean(rows.map((r) => r.points[i])).toFixed(2))),
      slope: Number(mean(rows.map((r) => r.slope)).toFixed(2)),
      dipAt: Number(mean(rows.map((r) => r.dipAt)).toFixed(2)),
      gapsPerSyllable: Number(mean(rows.map((r) => r.gaps)).toFixed(2)),
      medianHz: Math.round(mean(rows.map((r) => r.medianHz))),
    }));
    const dist = {};
    for (let i = 0; i < 6; i++)
      for (let j = i + 1; j < 6; j++)
        dist[`${TONE_NAMES[i]}/${TONE_NAMES[j]}`] = Number(
          contourDistance(summary[i], summary[j]).toFixed(2),
        );
    results.tones[label] = { summary, pairwiseContourDistanceSemitones: dist };
  }
});

mkdirSync(path.join(root, 'benchmark', 'vi', 'results'), { recursive: true });
const file = path.join(root, 'benchmark', 'vi', 'results', `espeak-${version}.json`);
writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      voices: Object.fromEntries(
        Object.entries(results.voices).map(([k, v]) => [
          k,
          {
            rendered: v.rendered,
            failed: v.failed,
            deterministic: v.deterministic,
            foreign: v.sentencesWithForeignSwitch,
            medianRtf: v.medianRtf,
            silentOrClipped: v.silentOrClipped,
          },
        ]),
      ),
      dialect: results.dialect,
    },
    null,
    2,
  ),
);
for (const [label, t] of Object.entries(results.tones)) {
  console.log(
    `\nTone contours (${label}), semitones relative to each syllable's own median, 5 points start→end:`,
  );
  for (const s of t.summary)
    console.log(
      `  ${s.tone.padEnd(6)} n=${s.measured}/${s.of} ${String(s.voicedMs).padStart(4)}ms slope ${String(s.slope).padStart(6)} dipAt ${s.dipAt} gaps ${s.gapsPerSyllable} pts [${s.points.join(', ')}] ~${s.medianHz}Hz`,
    );
}
console.log(`\nWrote ${path.relative(root, file)}`);
