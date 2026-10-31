#!/usr/bin/env node
// Automated QA for the AI voices (ADR 0008): needs the model service running and VIENEU_SERVICE_URLS /
// VIENEU_SERVICE_TOKEN set. Writes config/voice-qa-report.vieneu.json. It checks that synthesis works and the signal
// is sane; it does NOT judge naturalness or correct pronunciation: that needs a native speaker (manualReview).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import core from '../packages/core/dist/index.js';

const root = path.resolve(import.meta.dirname, '..');
const config = core.loadConfig();
if (!config.vieneuServiceUrls.length || !config.vieneuServiceToken) {
  console.error('Set VIENEU_SERVICE_URLS and VIENEU_SERVICE_TOKEN (see services/vieneu/README.md).');
  process.exit(2);
}
const adapter = new core.VieneuAdapter({
  urls: config.vieneuServiceUrls,
  token: config.vieneuServiceToken,
  approved: config.vieneuApproved,
});
const health = await adapter.healthCheck();
if (!health.ok) {
  console.error(`AI voice service is not ready: ${health.detail}`);
  process.exit(1);
}
await adapter.initialize();
const version = health.version;
const allowlist = core.loadAllowlist(root).filter((v) => v.engineId === 'vieneu');
const corpus = core.loadQaCorpus(root);
const installed = new Set((await adapter.listInstalledVoices()).map((v) => v.nativeId));
const reportPath = path.join(root, 'config', 'voice-qa-report.vieneu.json');
const previous = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;

const results = {};
for (const voice of allowlist) {
  const entry = corpus.entries.find((e) => e.voiceId === voice.id);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  let durationMs;
  if (!installed.has(voice.nativeId)) check('installed', false, 'preset voice not offered by the service');
  else if (!entry) check('corpus', false, 'no corpus text');
  else
    await core.withTempDir(config.tempDir, 'qa', async (dir) => {
      const caps = adapter.getCapabilities(voice.nativeId);
      const settings = core.defaultSettings(caps);
      try {
        const a = await adapter.synthesize(
          { text: entry.text, nativeVoiceId: voice.nativeId, settings },
          { tempDir: dir, timeoutMs: config.vieneuTimeoutMs },
        );
        const { samples } = core.decodeWavToFloat(await readFile(a.filePath));
        durationMs = a.durationMs;
        check('synthesis', true, `${a.sampleRate} Hz, ${a.channels} ch, ${a.durationMs} ms`);
        const chars = [...entry.text].length;
        check(
          'duration',
          a.durationMs >= 800 && a.durationMs <= chars * 250,
          `${a.durationMs} ms for ${chars} characters`,
        );
        const level = core.rms(samples);
        check('signal', level > 0.005, `RMS ${level.toFixed(4)}`);
        let fullScale = 0;
        for (const x of samples) if (Math.abs(x) >= 32767 / 32768) fullScale++;
        check(
          'no-clipping',
          fullScale <= samples.length * 0.0001,
          `${fullScale} full-scale samples, peak ${core.peakAbs(samples).toFixed(3)}`,
        );
        check(
          'controls',
          caps.rate.support === 'unsupported' && caps.tempo.support === 'dsp',
          'speed and pitch are audio-processing controls',
        );
      } catch (e) {
        check('synthesis', false, e.message ?? String(e));
      }
    });
  const prev = previous?.engineVersion === version ? previous.results?.[voice.id] : undefined;
  results[voice.id] = {
    status: checks.every((c) => c.ok) ? 'passed' : 'failed',
    checks,
    sampleText: entry?.text ?? '',
    durationMs,
    manualReview: prev?.manualReview ?? null,
  };
  console.log(
    `${results[voice.id].status.padEnd(6)} ${voice.id.padEnd(22)} ${checks
      .filter((c) => !c.ok)
      .map((c) => `${c.name}: ${c.detail}`)
      .join('; ')}`,
  );
}
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      engineId: 'vieneu',
      engineVersion: version,
      corpusVersion: corpus.version,
      generatedAt: new Date().toISOString(),
      results,
    },
    null,
    2,
  ) + '\n',
);
const passed = Object.values(results).filter((r) => r.status === 'passed').length;
console.log(
  `\n${passed}/${allowlist.length} AI voices passed automated QA. Report: config/voice-qa-report.vieneu.json`,
);
