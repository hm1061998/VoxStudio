#!/usr/bin/env node
// Automated voice QA: runs the corpus for every allowlisted voice against the installed engine
// and writes config/voice-qa-report.json. Requires `pnpm build` (uses packages/core/dist).
// Manual native-speaker reviews recorded in the existing report are preserved.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import core from '../packages/core/dist/index.js';

const root = path.resolve(import.meta.dirname, '..');
const config = core.loadConfig();
const adapter = new core.EspeakAdapter({
  executable: config.tools.espeak,
  approvedVersion: config.espeakApprovedVersion,
});
const version = await adapter.detectVersion();
await adapter.listVariants();
const allowlist = core.loadAllowlist(root).filter((v) => v.engineId === 'espeak');
const corpus = core.loadQaCorpus(root);
const installed = new Set((await adapter.listInstalledVoices()).map((v) => v.nativeId));
const reportPath = path.join(root, 'config', 'voice-qa-report.json');
const previous = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;

const results = {};
for (const voice of allowlist) {
  const entry = corpus.entries.find((e) => e.voiceId === voice.id);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  let durationMs;
  if (!installed.has(voice.nativeId)) check('installed', false, 'voice not installed');
  else if (!entry) check('corpus', false, 'no corpus text');
  else {
    await core.withTempDir(config.tempDir, 'qa', async (dir) => {
      const caps = adapter.getCapabilities(voice.nativeId);
      const settings = core.defaultSettings(caps);
      const ctx = { tempDir: dir, timeoutMs: 30_000 };
      try {
        const a = await adapter.synthesize(
          { text: entry.text, nativeVoiceId: voice.nativeId, settings },
          ctx,
        );
        const bufA = await readFile(a.filePath);
        const { samples } = core.decodeWavToFloat(bufA);
        durationMs = a.durationMs;
        check('synthesis', true, `${a.sampleRate} Hz, ${a.channels} ch, ${a.durationMs} ms`);
        const chars = [...entry.text].length;
        check(
          'duration',
          a.durationMs >= 500 && a.durationMs <= chars * 250,
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
        const b = await adapter.synthesize(
          { text: entry.text, nativeVoiceId: voice.nativeId, settings },
          ctx,
        );
        const h = (buf) => createHash('sha256').update(buf).digest('hex');
        check('deterministic', h(bufA) === h(await readFile(b.filePath)), 'two identical runs');
        const fast = await adapter.synthesize(
          { text: entry.text, nativeVoiceId: voice.nativeId, settings: { ...settings, rate: 1.5 } },
          ctx,
        );
        check('rate-control', fast.durationMs < a.durationMs * 0.85, `1.5× rate → ${fast.durationMs} ms`);
        const mn = await adapter.mnemonics(entry.text, voice.nativeId, ctx);
        // eSpeak marks words it reads with another language's rules as `(xx)word(back)`.
        const own = new Set([voice.nativeId.toLowerCase(), voice.nativeId.toLowerCase().split('-')[0]]);
        const switches = [...mn.matchAll(/\(([a-z]{2,3}(?:-[a-z0-9]+)*)\)/gi)]
          .map((m) => m[1].toLowerCase())
          .filter((l) => !own.has(l));
        const words = Math.max(1, entry.text.split(/\s+/).length);
        const ratio = switches.length / words;
        check(
          'no-language-fallback',
          ratio <= 0.1,
          switches.length
            ? `${switches.length} of ${words} words read with other-language rules (${[...new Set(switches)].join(', ')})`
            : 'stayed in voice language',
        );
      } catch (e) {
        check('synthesis', false, e.message ?? String(e));
      }
    });
  }
  const prevResult = previous?.engineVersion === version ? previous.results?.[voice.id] : undefined;
  results[voice.id] = {
    status: checks.every((c) => c.ok) ? 'passed' : 'failed',
    checks,
    sampleText: entry?.text ?? '',
    durationMs,
    manualReview: prevResult?.manualReview ?? null,
  };
  const notable = checks.filter(
    (c) => !c.ok || (c.name === 'no-language-fallback' && c.detail !== 'stayed in voice language'),
  );
  console.log(
    `${results[voice.id].status.padEnd(6)} ${voice.id.padEnd(16)} ${notable.map((c) => `${c.name}: ${c.detail}`).join('; ')}`,
  );
}

const report = {
  engineId: 'espeak',
  engineVersion: version,
  corpusVersion: corpus.version,
  generatedAt: new Date().toISOString(),
  results,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const passed = Object.values(results).filter((r) => r.status === 'passed').length;
console.log(
  `\n${passed}/${allowlist.length} voices passed automated QA. Report: config/voice-qa-report.json`,
);
