import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveToolPaths, inspectFfmpeg, assertFfmpegCompliant } from './tools';
import { EspeakAdapter } from './engine/espeak';
import { defaultSettings } from './engine/capabilities';
import { decodeWavToFloat, parseWavHeader, peakAbs, rms } from './audio/wav';
import { CANONICAL_SAMPLE_RATE } from './audio/dsp';
import { synthesizeSegment } from './render/segment';
import { assembleSegments } from './render/assembly';
import { encodeAndValidate, validateOutput } from './render/encode';
import { prepareEngineText } from './text/prepare';
import type { SynthesisSettings } from '@voxstudio/contracts';

const tools = resolveToolPaths();
const adapter = new EspeakAdapter({ executable: tools.espeak, approvedVersion: '1.52.0' });
let dir: string;
let ffmpegVersion = '';
let settings: SynthesisSettings;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'vs-core-it-'));
  await adapter.listVariants();
  settings = defaultSettings(adapter.getCapabilities('en-us'));
  ffmpegVersion = (await assertFfmpegCompliant(tools.ffmpeg)).version;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => ({ tempDir: dir, timeoutMs: 30_000 });
const synth = async (text: string, s: Partial<SynthesisSettings> = {}, voice = 'en-us') => {
  const out = await adapter.synthesize(
    { text, nativeVoiceId: voice, settings: { ...settings, ...s } },
    ctx(),
  );
  return { out, buf: readFileSync(out.filePath) };
};
const segment = (text: string, s: Partial<SynthesisSettings> = {}, voice = 'en-us') =>
  synthesizeSegment({
    chunks: prepareEngineText(text, 'en-US', 'espeak', []).chunks,
    nativeVoiceId: voice,
    settings: { ...settings, ...s },
    capabilities: adapter.getCapabilities(voice),
    adapter,
    ffmpeg: tools.ffmpeg,
    ffmpegVersion,
    tempDir: dir,
    timeoutMs: 30_000,
  });

describe('toolchain compliance', () => {
  it('eSpeak NG is the approved version and healthy', async () => {
    expect(await adapter.healthCheck()).toMatchObject({ ok: true, version: '1.52.0' });
  });
  it('FFmpeg has no prohibited speech/ML filters and has the required ones', async () => {
    const info = await inspectFfmpeg(tools.ffmpeg);
    expect(info.prohibitedFilters).toEqual([]);
    expect(info.missingFilters).toEqual([]);
    expect(info.encoders).toEqual({ mp3: true, vorbis: true });
  });
  it('lists installed voices without MBROLA', async () => {
    const voices = await adapter.listInstalledVoices();
    expect(voices.some((v) => v.nativeId === 'en-us')).toBe(true);
    expect(voices.some((v) => /mb[\\/]/.test(v.file))).toBe(false);
  });
});

describe('eSpeak NG adapter (real binary)', () => {
  it('synthesizes valid canonical WAV with signal', async () => {
    const { out, buf } = await synth('Hello, welcome to VoxStudio.');
    const info = parseWavHeader(buf);
    expect(info).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 22050, bitsPerSample: 16 });
    expect(out.durationMs).toBeGreaterThan(800);
    expect(rms(decodeWavToFloat(buf).samples)).toBeGreaterThan(0.01);
    expect(out.engine.args).not.toContain(out.filePath);
  });
  it('is deterministic', async () => {
    const a = await synth('Determinism check, one two three.');
    const b = await synth('Determinism check, one two three.');
    expect(sha(a.buf)).toBe(sha(b.buf));
  });
  it('native rate changes duration', async () => {
    const slow = await synth('The rate parameter should change the duration of this sentence.', {
      rate: 0.75,
    });
    const fast = await synth('The rate parameter should change the duration of this sentence.', {
      rate: 1.5,
    });
    expect(fast.out.durationMs).toBeLessThan(slow.out.durationMs * 0.7);
  });
  it('native pitch, pitch range, variant and word gap change the audio', async () => {
    const text = 'Pitch and variant test.';
    const base = sha((await synth(text)).buf);
    for (const s of [
      { pitch: 80 },
      { pitchRange: 10 },
      { variant: 'f2' },
      { variant: 'klatt' },
      { wordGapMs: 200 },
    ] as Partial<SynthesisSettings>[])
      expect(sha((await synth(text, s)).buf)).not.toBe(base);
    const gap = await synth(text, { wordGapMs: 300 });
    const plain = await synth(text);
    expect(gap.out.durationMs).toBeGreaterThan(plain.out.durationMs + 500);
  });
  it('rejects variants that are not installed instead of silently ignoring them', async () => {
    await expect(synth('x', { variant: 'not-a-variant' })).rejects.toThrow(/not installed/);
  });
  it('treats shell and phoneme syntax in user text as plain text', async () => {
    const marker = path.join(dir, 'pwned.txt');
    const text = `"; echo hacked > ${marker} & $(touch ${marker}) \`touch ${marker}\` [[h@l'oU]] -w ${marker}`;
    const { out } = await synth(text);
    expect(out.durationMs).toBeGreaterThan(1000);
    expect(existsSync(marker)).toBe(false);
    const ph = await adapter.phonemes('[[h@l"oU]]', 'en-us', ctx());
    expect(ph).not.toBe(await adapter.phonemes('hello', 'en-us', ctx()));
  });
  it('handles Unicode across scripts', async () => {
    for (const [text, voice] of [
      ['Café, naïve façade — “quotes” ✓', 'en-us'],
      ['Доброе утро.', 'ru'],
      ['你好，世界。', 'cmn'],
      ['مرحبا بالعالم', 'ar'],
    ] as const) {
      const { out } = await synth(text, {}, voice);
      expect(out.durationMs).toBeGreaterThan(300);
    }
  });
  it('rejects malformed voice ids', async () => {
    await expect(synth('x', {}, '../../evil')).rejects.toThrow(/Invalid voice/);
  });
  it('produces IPA phonemes for preview', async () => {
    expect(await adapter.phonemes('hello', 'en-us', ctx())).toMatch(/h.*l.*oʊ/);
  });
});

describe('segment pipeline (engine + DSP)', () => {
  it('inserts sample-accurate inline pauses', async () => {
    const plain = await segment('One. Two.');
    const a = await segment('One. [pause 750ms] Two.');
    const one = await segment('One.');
    const two = await segment('Two.');
    const framesOf = (b: Buffer) => parseWavHeader(b).frames;
    expect(framesOf(a.wav)).toBe(
      framesOf(one.wav) + framesOf(two.wav) + Math.round(0.75 * CANONICAL_SAMPLE_RATE),
    );
    expect(framesOf(a.wav)).not.toBe(framesOf(plain.wav));
  });
  it('time stretch (DSP) changes duration while native rate path stays separate', async () => {
    const base = await segment('This sentence is used to test the time stretch stage.');
    const slow = await segment('This sentence is used to test the time stretch stage.', { tempo: 0.8 });
    expect(slow.durationMs / base.durationMs).toBeGreaterThan(1.2);
    expect(slow.durationMs / base.durationMs).toBeLessThan(1.3);
    expect(slow.dspSnapshot.filters).toContain('atempo=0.8');
  });
  it('pitch shift (DSP) keeps duration within tolerance and changes audio', async () => {
    const base = await segment('Pitch shift should not change duration.');
    const up = await segment('Pitch shift should not change duration.', { pitchShiftSemitones: 4 });
    expect(Math.abs(up.durationMs - base.durationMs)).toBeLessThan(base.durationMs * 0.03);
    expect(sha(up.wav)).not.toBe(sha(base.wav));
  });
  it('EQ and compressor run without error and alter output', async () => {
    const base = await segment('Equalizer test.');
    const eq = await segment('Equalizer test.', {
      highpassHz: 120,
      lowShelfDb: -6,
      presenceDb: 4,
      highShelfDb: 3,
      compressor: true,
    });
    expect(sha(eq.wav)).not.toBe(sha(base.wav));
  });
  it('volume gain never clips and reports attenuation', async () => {
    const loud = await segment('Maximum gain test.', { volumeDb: 12 });
    const samples = decodeWavToFloat(loud.wav).samples;
    expect(peakAbs(samples)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-3);
    expect(loud.warnings.join(' ')).toMatch(/attenuated/);
    const quiet = await segment('Maximum gain test.', { volumeDb: -12 });
    const base = await segment('Maximum gain test.');
    expect(rms(decodeWavToFloat(quiet.wav).samples) / rms(decodeWavToFloat(base.wav).samples)).toBeCloseTo(
      Math.pow(10, -12 / 20),
      2,
    );
  });
  it('warns outside the recommended DSP range', async () => {
    const r = await segment('Extreme.', { tempo: 1.6 });
    expect(r.warnings.join(' ')).toMatch(/outside the recommended range/);
  });
  it('fails clearly on empty text', async () => {
    await expect(segment('   [pause 200ms]  ')).rejects.toThrow(/no speakable text/);
  });
});

describe('assembly + export', () => {
  let items: {
    segmentId: string;
    position: number;
    wavPath: string;
    pauseBeforeMs: number;
    pauseAfterMs: number;
  }[];
  let frames: number[];
  beforeAll(async () => {
    items = [];
    frames = [];
    for (const [i, text] of ['First segment.', 'Second segment.', 'Third segment.'].entries()) {
      const r = await segment(text);
      const p = path.join(dir, `seg-${i}.wav`);
      writeFileSync(p, r.wav);
      frames.push(parseWavHeader(r.wav).frames);
      items.push({
        segmentId: `s${i}`,
        position: i,
        wavPath: p,
        pauseBeforeMs: i === 1 ? 100 : 0,
        pauseAfterMs: 400,
      });
    }
  });

  it('assembles in order with exact pauses and a correct timeline', async () => {
    const out = path.join(dir, 'master.wav');
    const r = await assembleSegments(items, out, 0);
    const expected =
      frames.reduce((n, f) => n + f, 0) + Math.round(0.1 * 22050) + 3 * Math.round(0.4 * 22050);
    expect(r.frames).toBe(expected);
    expect(parseWavHeader(readFileSync(out)).frames).toBe(expected);
    expect(r.timeline.map((t) => t.segmentId)).toEqual(['s0', 's1', 's2']);
    expect(r.timeline[1]!.speechStartMs - r.timeline[1]!.startMs).toBe(100);
    expect(r.timeline[2]!.endMs).toBe(r.durationMs);
    // Segment 2's audio must start exactly where the timeline says.
    const master = decodeWavToFloat(readFileSync(out)).samples;
    const seg1 = decodeWavToFloat(readFileSync(items[1]!.wavPath)).samples;
    const start = frames[0]! + Math.round(0.4 * 22050) + Math.round(0.1 * 22050);
    expect(Array.from(master.subarray(start, start + 200))).toEqual(Array.from(seg1.subarray(0, 200)));
  });

  it('applies optional join fades', async () => {
    const out = path.join(dir, 'master-fade.wav');
    await assembleSegments(items, out, 10);
    const master = decodeWavToFloat(readFileSync(out)).samples;
    expect(master[0]).toBe(0);
  });

  for (const profile of [
    { format: 'wav', sampleRate: 22050, channels: 1, bitDepth: 16 },
    { format: 'wav', sampleRate: 48000, channels: 2, bitDepth: 24 },
    { format: 'mp3', sampleRate: 44100, channels: 1, bitrateKbps: 128 },
    { format: 'ogg', sampleRate: 44100, channels: 2, bitrateKbps: 96 },
  ] as const) {
    it(`encodes and validates ${profile.format} ${profile.sampleRate} Hz ${profile.channels} ch`, async () => {
      const master = path.join(dir, 'm.wav');
      const r = await assembleSegments(items, master, 0);
      const out = path.join(dir, `out-${profile.format}-${profile.sampleRate}.${profile.format}`);
      const probe = await encodeAndValidate(tools, master, out, profile, r.durationMs, { timeoutMs: 60_000 });
      expect(probe.sampleRate).toBe(profile.sampleRate);
      expect(probe.channels).toBe(profile.channels);
    });
  }

  it('fails validation on a corrupt file', async () => {
    const bad = path.join(dir, 'bad.mp3');
    writeFileSync(bad, Buffer.from('ID3 this is not audio data at all'.repeat(20)));
    await expect(
      validateOutput(tools, bad, { format: 'mp3', sampleRate: 44100, channels: 1 }, 1000, 10_000),
    ).rejects.toThrow();
  });

  it('leaves no stray engine files outside the temp dir', () => {
    expect(readdirSync(dir).every((f) => !f.includes('..'))).toBe(true);
  });
});

describe('Vietnamese front-end against the real engine', () => {
  /** Drop word separators so syllable sequences can be compared. */
  const clean = (m: string) => m.replace(/_\|/g, '').replace(/\s+/g, ' ').trim();
  const read = async (text: string) => {
    const spoken = prepareEngineText(text, 'vi-VN', 'espeak', [])
      .chunks.map((c) => (c.kind === 'speech' ? c.text : ''))
      .join(' ');
    return clean(await adapter.mnemonics(spoken, 'vi', ctx()));
  };
  const raw = async (text: string) => clean(await adapter.mnemonics(text, 'vi', ctx()));

  it('reads numeric ranges with "đến" (raw text omits it)', async () => {
    expect(await raw('từ 10-20 người')).not.toContain('d_,e3n');
    expect(await read('từ 10-20 người')).toContain('d_,e3n');
  });
  it('reads phone numbers digit by digit (raw text is read as hundreds)', async () => {
    expect(await raw('Gọi 0912 345 678')).toContain("tS'a1m");
    expect(await read('Gọi 0912 345 678')).not.toContain("tS'a1m");
  });
  it('reads Roman-numeral centuries as numbers instead of letters', async () => {
    expect(await raw('thế kỷ XXI')).toContain(',i3c');
    const spoken = await read('thế kỷ XXI');
    expect(spoken).not.toContain(',i3c');
    expect(spoken).toContain("h'a:I1 m'y@7j");
  });
  it('keeps the six Vietnamese tones distinct', async () => {
    const tones = (await adapter.mnemonics('ma má mà mả mã mạ', 'vi', ctx())).match(/a:(\d)/g);
    expect(new Set(tones).size).toBe(6);
  });
});
