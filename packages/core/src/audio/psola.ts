import type { PitchMark } from './f0';

export interface PsolaParams {
  /** Output length = input length × durationFactor (> 1 slower, < 1 faster). */
  durationFactor: number;
  /** Pitch shift in semitones as a function of normalised time t ∈ [0, 1]. Unvoiced regions are not shifted. */
  pitchShiftSt: (t: number) => number;
}

const MIN_FACTOR = 0.4;
const MAX_FACTOR = 3;
const hann = (i: number, len: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / len);

/**
 * Time-domain pitch-synchronous overlap-add (TD-PSOLA). Deterministic conventional DSP: windowed
 * two-period grains centred on pitch marks are re-spaced for pitch (spacing / factor) and repeated or
 * dropped for duration. Overlapping windows are normalised so level stays constant.
 */
export function psola(samples: Float32Array, marks: PitchMark[], params: PsolaParams): Float32Array {
  const n = samples.length;
  const alpha = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, params.durationFactor));
  const outLen = Math.max(1, Math.round(n * alpha));
  const out = new Float32Array(outLen);
  if (!n) return out;
  if (marks.length < 2) {
    // No analysis marks: plain time-stretch by index mapping (no pitch change possible).
    for (let i = 0; i < outLen; i++) out[i] = samples[Math.min(n - 1, Math.floor(i / alpha))] ?? 0;
    return out;
  }
  const norm = new Float32Array(outLen);
  const periodAt = (k: number): number => {
    const prev = marks[Math.max(0, k - 1)]!.pos;
    const next = marks[Math.min(marks.length - 1, k + 1)]!.pos;
    const span = k === 0 || k === marks.length - 1 ? next - prev : (next - prev) / 2;
    return Math.max(8, Math.round(span || 8));
  };
  let ts = 0;
  let k = 0;
  while (ts < outLen) {
    const ta = ts / alpha;
    while (k < marks.length - 1 && Math.abs(marks[k + 1]!.pos - ta) <= Math.abs(marks[k]!.pos - ta)) k++;
    const m = marks[k]!;
    const P = periodAt(k);
    const len = 2 * P;
    const start = m.pos - P;
    const placeAt = Math.round(ts) - P;
    for (let i = 0; i < len; i++) {
      const src = start + i;
      const dst = placeAt + i;
      if (dst < 0 || dst >= outLen) continue;
      const w = hann(i, len);
      const s = src >= 0 && src < n ? (samples[src] ?? 0) : 0;
      out[dst]! += s * w;
      norm[dst]! += w;
    }
    const shift = m.voiced ? params.pitchShiftSt(Math.min(1, ta / n)) : 0;
    const beta = Math.pow(2, shift / 12);
    ts += P / beta;
  }
  for (let i = 0; i < outLen; i++) {
    const w = norm[i] ?? 0;
    out[i] = w > 0.1 ? (out[i] ?? 0) / w : 0;
  }
  return out;
}

/** Marks for a signal of `length` samples at the same spacing as `source` marks, mapped through a factor. */
export function scaleMarks(marks: PitchMark[], factor: number): PitchMark[] {
  return marks.map((m) => ({ pos: Math.round(m.pos * factor), voiced: m.voiced }));
}
