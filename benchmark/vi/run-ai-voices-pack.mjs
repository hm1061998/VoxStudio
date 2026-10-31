#!/usr/bin/env node
// Renders benchmark sentences with every AI voice through the application's own engine path (text preparation +
// VieneuAdapter + the same DSP chain) so a person can compare genders and regions. Needs the model service running.
// Usage: VIENEU_SERVICE_URLS=... VIENEU_SERVICE_TOKEN=... node benchmark/vi/run-ai-voices-pack.mjs [--out qa-output/ai-voices-pack]
// Ratings stay blank: only listeners can judge naturalness, pronunciation or whether an accent is right.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import core from '../../packages/core/dist/index.js';
import { SENTENCES } from './sentences.mjs';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const out = path.resolve(arg('--out', 'qa-output/ai-voices-pack'));
const config = core.loadConfig();
if (!config.vieneuServiceUrls.length) {
  console.error('Set VIENEU_SERVICE_URLS and VIENEU_SERVICE_TOKEN.');
  process.exit(2);
}
const adapter = new core.VieneuAdapter({
  urls: config.vieneuServiceUrls,
  token: config.vieneuServiceToken,
  approved: true,
});
if (!(await adapter.healthCheck()).ok) {
  console.error('The AI model service is not ready.');
  process.exit(1);
}
await adapter.initialize();
const ffmpegVersion = (await core.assertFfmpegCompliant(config.tools.ffmpeg)).version;
const voices = (await adapter.listInstalledVoices()).map((v) => {
  const p = adapter.getVoiceProfile(v.nativeId);
  return { id: v.nativeId, name: v.file, region: p.region, gender: p.gender };
});
const order = { northern: 0, central: 1, southern: 2 };
voices.sort(
  (a, b) =>
    (order[a.region] ?? 9) - (order[b.region] ?? 9) || String(a.gender).localeCompare(String(b.gender)),
);

const IDS = ['001', '105', '110', '113', '061', '079', '126'].map((n) => `vi-bench-1-${n}`);
const picked = IDS.map((id) => SENTENCES.find((s) => s.id === id));
mkdirSync(out, { recursive: true });
const rows = [];
for (const v of voices) {
  const dir = path.join(out, `${v.region}-${v.gender}-${v.id}`);
  mkdirSync(dir, { recursive: true });
  const caps = adapter.getCapabilities(v.id);
  for (const s of picked) {
    const prepared = core.prepareEngineText(s.text, 'vi-VN', 'vieneu', []);
    const t0 = performance.now();
    const r = await core.withTempDir(config.tempDir, 'aipack', (tmp) =>
      core.synthesizeSegment({
        chunks: prepared.chunks,
        nativeVoiceId: v.id,
        settings: core.defaultSettings(caps),
        capabilities: caps,
        adapter,
        ffmpeg: config.tools.ffmpeg,
        ffmpegVersion,
        tempDir: tmp,
        timeoutMs: config.vieneuTimeoutMs,
      }),
    );
    const file = path.join(dir, `${s.id}.wav`);
    writeFileSync(file, r.wav);
    rows.push({
      voice: v,
      id: s.id,
      category: s.category,
      text: s.text,
      file: path.relative(out, file),
      audioMs: r.durationMs,
      wallMs: Math.round(performance.now() - t0),
    });
    console.log(
      `${v.region}/${v.gender} ${v.name} ${s.id} ${r.durationMs} ms (${Math.round(performance.now() - t0)} ms)`,
    );
  }
}
// Same sentences from eSpeak NG for reference (copied from the earlier sample pack when present).
const espeakSrc = path.resolve('qa-output/sample-pack/voices');
mkdirSync(path.join(out, 'espeak-reference'), { recursive: true });
for (const s of picked)
  for (const label of ['northern', 'central', 'southern']) {
    const f = path.join(espeakSrc, `${s.id}-${label}.wav`);
    if (existsSync(f)) copyFileSync(f, path.join(out, 'espeak-reference', `${s.id}-espeak-${label}.wav`));
  }
const BOM = String.fromCharCode(0xfeff);
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const header = [
  'file',
  'region',
  'gender',
  'preset',
  'sentence',
  'text',
  'accent_matches_region_yes_no',
  'tone_correctness_1to5',
  'naturalness_1to5',
  'intelligibility_1to5',
  'artifacts_1to5_5=none',
  'notes',
];
writeFileSync(
  path.join(out, 'listening-sheet.csv'),
  `${BOM}${header.join(',')}\n${rows.map((r) => [r.file, r.voice.region, r.voice.gender, r.voice.name, r.id, r.text].map(q).join(',') + ',,,,,,').join('\n')}\n`,
);
writeFileSync(
  path.join(out, 'README.md'),
  `# AI voices pack (VieNeu-TTS v3 Turbo, preset voices)\n\n${rows.length} WAV files: ${voices.length} voices x ${picked.length} benchmark sentences, produced through the application's own engine path. Folders are named region-gender-voice. \`espeak-reference/\` holds the same sentences from eSpeak NG.\n\nRegion and gender are the model provider's description of each preset voice and have NOT been verified by a listener. \`listening-sheet.csv\` has blank ratings.\n`,
);
console.log(`\n${rows.length} files in ${out}`);
