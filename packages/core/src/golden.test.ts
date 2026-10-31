import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFfmpegCompliant, resolveToolPaths } from './tools';
import { EspeakAdapter } from './engine/espeak';
import { defaultSettings } from './engine/capabilities';
import { synthesizeSegment } from './render/segment';
import { prepareEngineText } from './text/prepare';

/**
 * Golden regression: pins the exact audio bytes produced by the full pipeline (normalization →
 * eSpeak NG → DSP → canonical WAV) so engine-layer refactors can prove they changed nothing.
 * Hashes are specific to eSpeak NG 1.52.0 and the FFmpeg filters involved; when either tool is
 * upgraded, re-capture them deliberately (GOLDEN_UPDATE=1 prints the new values).
 */
const GOLDEN: Record<string, string> = {
  'en-us plain': '2d24a5e08a3026da06e4195259315f321bf2619b9bac0440583b3860e9043a1c',
  'en-us dsp': '4a6e7c0b1acbff713e622d95b720979675a9c7bb2a710459b16286f91f1e62db',
  'vi northern': '53d7fbf9fd67b805d6dde30a376a4132186ec00acebff3144e75d5215926ad20',
  'vi south normalized': '95231ad3c533178a71d4ad085e3397e2fad60ea2ed7a847409b354f1930140b3',
};

const tools = resolveToolPaths();
const adapter = new EspeakAdapter({ executable: tools.espeak, approvedVersion: '1.52.0' });
let dir: string;
let ffmpegVersion = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'vs-golden-'));
  await adapter.listVariants();
  ffmpegVersion = (await assertFfmpegCompliant(tools.ffmpeg)).version;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function render(text: string, locale: string, voice: string, patch = {}) {
  const caps = adapter.getCapabilities(voice);
  const r = await synthesizeSegment({
    chunks: prepareEngineText(text, locale, 'espeak', []).chunks,
    nativeVoiceId: voice,
    settings: { ...defaultSettings(caps), ...patch },
    capabilities: caps,
    adapter,
    ffmpeg: tools.ffmpeg,
    ffmpegVersion,
    tempDir: dir,
    timeoutMs: 30_000,
  });
  return createHash('sha256').update(r.wav).digest('hex');
}

const CASES: [string, () => Promise<string>][] = [
  ['en-us plain', () => render('Hello, welcome to VoxStudio. It costs $5 today.', 'en-US', 'en-us')],
  [
    'en-us dsp',
    () =>
      render('Golden DSP check.', 'en-US', 'en-us', {
        rate: 1.2,
        tempo: 0.9,
        volumeDb: -3,
        highpassHz: 80,
        compressor: true,
      }),
  ],
  ['vi northern', () => render('Xin chào các bạn. Hôm nay trời đẹp.', 'vi-VN', 'vi')],
  [
    'vi south normalized',
    () => render('Ngày 31/10/2026, giá 150.000đ, lúc 14h30. [pause 300ms] Hết.', 'vi-VN', 'vi-vn-x-south'),
  ],
];

describe('golden audio (eSpeak NG 1.52.0)', () => {
  it('runs against the approved engine version', async () => {
    expect((await adapter.healthCheck()).version).toBe('1.52.0');
  });
  for (const [name, run] of CASES)
    it(`is byte-identical: ${name}`, async () => {
      const hash = await run();
      if (process.env.GOLDEN_UPDATE) console.log(`GOLDEN ${JSON.stringify(name)}: '${hash}'`);
      else expect(hash).toBe(GOLDEN[name]);
    });
});
