#!/usr/bin/env node
// Builds a Vietnamese listening pack from the real engine(s) and measures objective effects of each setting.
// Usage: pnpm build && node benchmark/vi/run-sample-pack.mjs [--out qa-output/sample-pack]
// Output: WAV files, manifest.json (hashes + measurements), listening-sheet.csv (ratings left BLANK for human
// listeners) and README.md. It never scores naturalness, intelligibility or tone correctness: only people can.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import core from '../../packages/core/dist/index.js';
import { BENCHMARK_VERSION, SENTENCES } from './sentences.mjs';

const out = path.resolve(
  process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'qa-output/sample-pack',
);
mkdirSync(out, { recursive: true });
const config = core.loadConfig();
const adapter = new core.EspeakAdapter({
  executable: config.tools.espeak,
  approvedVersion: config.espeakApprovedVersion,
});
const version = await adapter.detectVersion();
await adapter.initialize();
const ffmpegVersion = (await core.assertFfmpegCompliant(config.tools.ffmpeg)).version;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const VOICES = [
  ['vi', 'northern'],
  ['vi-vn-x-central', 'central'],
  ['vi-vn-x-south', 'southern'],
];

/** One representative sentence per benchmark category (the first one). */
const perCategory = [];
for (const s of SENTENCES) if (!perCategory.some((x) => x.category === s.category)) perCategory.push(s);

const manifest = {
  benchmark: BENCHMARK_VERSION,
  engine: `espeak@${version}`,
  ffmpeg: ffmpegVersion,
  items: [],
};

async function render(sentence, nativeId, overrides) {
  const caps = adapter.getCapabilities(nativeId);
  const settings = { ...core.defaultSettings(caps), ...overrides };
  core.validateSettingsForVoice(settings, caps);
  const prepared = core.prepareEngineText(sentence.text, 'vi-VN', 'espeak', []);
  return core.withTempDir(config.tempDir, 'pack', async (dir) => {
    const t0 = performance.now();
    const r = await core.synthesizeSegment({
      chunks: prepared.chunks,
      nativeVoiceId: nativeId,
      settings,
      capabilities: caps,
      adapter,
      ffmpeg: config.tools.ffmpeg,
      ffmpegVersion,
      tempDir: dir,
      timeoutMs: 60_000,
    });
    const wallMs = performance.now() - t0;
    const { samples } = core.decodeWavToFloat(r.wav);
    const f0 = core.summarizeF0(core.trackF0(samples, 22050));
    return {
      wav: r.wav,
      m: {
        audioMs: r.durationMs,
        wallMs: Math.round(wallMs),
        rtf: Number((wallMs / r.durationMs).toFixed(3)),
        medianF0Hz: f0 ? Math.round(f0.medianHz) : null,
        startF0Hz: f0 ? Math.round(f0.startHz) : null,
        endF0Hz: f0 ? Math.round(f0.endHz) : null,
        rms: Number(core.rms(samples).toFixed(4)),
        peak: Number(core.peakAbs(samples).toFixed(3)),
      },
    };
  });
}

async function emit(group, sentence, label, nativeId, overrides) {
  const { wav, m } = await render(sentence, nativeId, overrides);
  const name = `${group}/${sentence.id}-${label}.wav`;
  mkdirSync(path.join(out, group), { recursive: true });
  writeFileSync(path.join(out, name), wav);
  manifest.items.push({
    file: name,
    group,
    sentence: sentence.id,
    category: sentence.category,
    text: sentence.text,
    voice: nativeId,
    config: label,
    overrides,
    sha256: sha(wav),
    ...m,
  });
  return m;
}

// 1. Regional voice profiles, default settings, one sentence per category.
for (const s of perCategory) for (const [v, label] of VOICES) await emit('voices', s, label, v, {});

// 2. Prosody configurations on the Northern voice (4 sentences x 7 configurations).
const PROSODY = [
  ['default', {}],
  ['rate-0.75', { rate: 0.75 }],
  ['rate-1.4', { rate: 1.4 }],
  ['pitch-30', { pitch: 30 }],
  ['pitch-70', { pitch: 70 }],
  ['range-10', { pitchRange: 10 }],
  ['range-90', { pitchRange: 90 }],
];
const prosodySentences = ['tone-coverage', 'questions', 'statements', 'long-form-narration'].map((c) =>
  perCategory.find((s) => s.category === c),
);
const effects = [];
for (const s of prosodySentences) {
  const base = await emit('prosody', s, 'default', 'vi', {});
  for (const [label, o] of PROSODY.slice(1)) {
    const m = await emit('prosody', s, label, 'vi', o);
    effects.push({
      sentence: s.id,
      config: label,
      durationRatio: Number((m.audioMs / base.audioMs).toFixed(3)),
      medianF0Ratio:
        base.medianF0Hz && m.medianF0Hz ? Number((m.medianF0Hz / base.medianF0Hz).toFixed(3)) : null,
    });
  }
}
manifest.measuredEffects = effects;

// 3. Listening sheet (ratings blank) + README.
const header = [
  'file',
  'group',
  'sentence',
  'voice',
  'config',
  'text',
  'pronunciation_1to5',
  'tone_correctness_1to5',
  'syllable_transitions_1to5',
  'accent_consistency_1to5',
  'natural_pauses_1to5',
  'sentence_intonation_1to5',
  'intelligibility_1to5',
  'artifacts_1to5_5=none',
  'notes',
  'listener',
  'date',
];
const BOM = String.fromCharCode(0xfeff);
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
writeFileSync(
  path.join(out, 'listening-sheet.csv'),
  `${BOM}${[
    header.join(','),
    ...manifest.items
      .map(
        (i) =>
          [i.file, i.group, i.sentence, i.voice, i.config, i.text].map(q).join(',') +
          ',' +
          header
            .slice(6)
            .map(() => '')
            .join(','),
      )
      .join('\n'),
  ].join('\n')}\n`,
);
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(
  path.join(out, 'README.md'),
  `# Vietnamese listening pack (${BENCHMARK_VERSION}, eSpeak NG ${version})

Generated by \`node benchmark/vi/run-sample-pack.mjs\`. ${manifest.items.length} real WAV files (22,050 Hz mono, produced by the application's pipeline).

- \`voices/\`: one benchmark sentence per category, Northern / Central / Southern voices, default settings.
- \`prosody/\`: four sentences on the Northern voice with rate, pitch and pitch-range changes.
- \`listening-sheet.csv\`: rating columns are **blank on purpose**. A native Vietnamese listener rates each file 1-5 per criterion with good headphones. Nothing in this pack has been rated.
- \`manifest.json\`: SHA-256 and objective measurements (duration, F0, RMS, peak, real-time factor).
`,
);
console.log(`${manifest.items.length} files written to ${out}`);
console.table(effects.slice(0, 12));
