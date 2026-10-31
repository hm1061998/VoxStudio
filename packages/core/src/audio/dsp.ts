import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ErrorCodes, VoxError, type SynthesisSettings, type VoiceCapabilities } from '@voxstudio/contracts';
import { runProcess, redactToolOutput } from '../process';
import { ALLOWED_FFMPEG_FILTERS } from '../tools';
import { dbToLinear, decodeWavToFloat, linearToDb, msToSamples, peakAbs } from './wav';

/** Version of the processing chain order and fixed parameters. Bump when either changes. */
export const DSP_CHAIN_VERSION = 'dsp-1';
/** Canonical intermediate format: mono float processing, stored as PCM s16 at the engine rate. */
export const CANONICAL_SAMPLE_RATE = 22050;
/** Peak ceiling: samples above −1 dBFS trigger deterministic attenuation (never silent clipping). */
export const PEAK_CEILING = dbToLinear(-1);

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) throw new VoxError(ErrorCodes.DSP_FAILED, 'Invalid DSP parameter.');
  return Number(n.toFixed(6)).toString();
};

/**
 * FFmpeg filter chain for one speech chunk, in the documented order (docs 08 §3):
 * canonical format → time stretch → pitch shift → EQ → dynamics. Gain and headroom run in
 * VoxStudio code afterwards. Returns null when no FFmpeg stage is needed.
 */
export function buildFilterChain(s: SynthesisSettings): string[] | null {
  const f: string[] = [];
  if (s.tempo !== 1) f.push(`atempo=${fmt(s.tempo)}`);
  if (s.pitchShiftSemitones !== 0) f.push(`rubberband=pitch=${fmt(Math.pow(2, s.pitchShiftSemitones / 12))}`);
  if (s.highpassHz > 0) f.push(`highpass=f=${fmt(s.highpassHz)}`);
  if (s.lowShelfDb !== 0) f.push(`bass=g=${fmt(s.lowShelfDb)}:f=150`);
  if (s.presenceDb !== 0) f.push(`equalizer=f=3000:t=q:w=1:g=${fmt(s.presenceDb)}`);
  if (s.highShelfDb !== 0) f.push(`treble=g=${fmt(s.highShelfDb)}:f=8000`);
  if (s.compressor) f.push('acompressor=threshold=0.125893:ratio=2:attack=20:release=250:makeup=1');
  if (!f.length) return null;
  const chain = ['aformat=sample_fmts=flt:channel_layouts=mono', ...f];
  for (const filter of chain) {
    const name = filter.split('=')[0] as (typeof ALLOWED_FFMPEG_FILTERS)[number];
    if (!ALLOWED_FFMPEG_FILTERS.includes(name))
      throw new VoxError(ErrorCodes.DSP_FAILED, 'Filter not allowed.');
  }
  return chain;
}

/** Warnings shown to users for settings outside recommended ranges. */
export function settingsWarnings(s: SynthesisSettings, caps: VoiceCapabilities): string[] {
  const out: string[] = [];
  for (const key of ['tempo', 'pitchShiftSemitones'] as const) {
    const cap = caps[key];
    if (cap.kind !== 'number') continue;
    const v = s[key];
    if (
      (cap.recommendedMin !== undefined && v < cap.recommendedMin) ||
      (cap.recommendedMax !== undefined && v > cap.recommendedMax)
    )
      out.push(
        `${cap.label} ${v}${cap.unit === '×' ? '×' : ` ${cap.unit}`} is outside the recommended range; audible artifacts are likely.`,
      );
  }
  return out;
}

export async function applyFfmpegChain(
  ffmpeg: string,
  inputWav: string,
  chain: string[],
  opts: { tempDir: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Float32Array> {
  const out = path.join(opts.tempDir, `dsp-${process.hrtime.bigint()}.wav`);
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    inputWav,
    '-af',
    chain.join(','),
    '-ar',
    String(CANONICAL_SAMPLE_RATE),
    '-ac',
    '1',
    '-c:a',
    'pcm_f32le',
    '-f',
    'wav',
    out,
  ];
  const r = await runProcess(ffmpeg, args, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  if (r.code !== 0)
    throw new VoxError(ErrorCodes.DSP_FAILED, 'Audio processing failed.', {
      tool: redactToolOutput(r.stderr),
    });
  return decodeWavToFloat(await readFile(out)).samples;
}

export interface GainResult {
  samples: Float32Array;
  peakDbfsBefore: number;
  attenuationDb: number;
}

/** Apply gain, then guarantee no sample exceeds the ceiling by uniform attenuation. */
export function applyGainWithHeadroom(samples: Float32Array, gainDb: number): GainResult {
  const gain = dbToLinear(gainDb);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) * gain;
  const peak = peakAbs(out);
  let attenuationDb = 0;
  if (peak > PEAK_CEILING) {
    const scale = PEAK_CEILING / peak;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * scale;
    attenuationDb = -linearToDb(scale);
  }
  return { samples: out, peakDbfsBefore: linearToDb(peak), attenuationDb };
}

export function silence(ms: number, sampleRate = CANONICAL_SAMPLE_RATE): Float32Array {
  return new Float32Array(msToSamples(ms, sampleRate));
}

export function concatFloat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
