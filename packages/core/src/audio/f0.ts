// Dependency-free, deterministic F0 tracking (normalized autocorrelation) and pitch-mark placement.
// Used to build unit databases and to measure synthesized audio; no learned models.

export interface F0Point {
  /** Time of the frame centre, seconds. */
  t: number;
  /** Fundamental frequency in Hz, or null for unvoiced/silent frames. */
  f0: number | null;
  energy: number;
}

const FRAME_MS = 40;
const HOP_MS = 10;
export const F0_MIN = 60;
export const F0_MAX = 450;

export function trackF0(samples: Float32Array, sampleRate: number, fMin = F0_MIN, fMax = F0_MAX): F0Point[] {
  const frame = Math.round((FRAME_MS / 1000) * sampleRate);
  const hop = Math.round((HOP_MS / 1000) * sampleRate);
  const minLag = Math.floor(sampleRate / fMax);
  const maxLag = Math.ceil(sampleRate / fMin);
  const frames: { start: number; e: number }[] = [];
  let maxEnergy = 0;
  for (let start = 0; start + frame + maxLag <= samples.length; start += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += (samples[start + i] ?? 0) ** 2;
    e = Math.sqrt(e / frame);
    frames.push({ start, e });
    if (e > maxEnergy) maxEnergy = e;
  }
  const out: F0Point[] = [];
  for (const { start, e } of frames) {
    let best = 0;
    let bestLag = 0;
    if (e > maxEnergy * 0.1) {
      let r0 = 0;
      for (let i = 0; i < frame; i++) r0 += (samples[start + i] ?? 0) ** 2;
      const nrs = new Float32Array(maxLag + 2);
      for (let lag = minLag; lag <= maxLag; lag++) {
        let r = 0;
        let rl = 0;
        for (let i = 0; i < frame; i++) {
          const b = samples[start + i + lag] ?? 0;
          r += (samples[start + i] ?? 0) * b;
          rl += b * b;
        }
        const nr = r / Math.sqrt(r0 * rl + 1e-12);
        nrs[lag] = nr;
        if (nr > best) {
          best = nr;
          bestLag = lag;
        }
      }
      // Octave guard: prefer the shortest lag that is a local maximum with nearly the same correlation.
      for (let lag = minLag + 1; lag < bestLag; lag++) {
        const v = nrs[lag] ?? 0;
        if (v >= best * 0.9 && v >= (nrs[lag - 1] ?? 0) && v >= (nrs[lag + 1] ?? 0)) {
          bestLag = lag;
          best = v;
          break;
        }
      }
    }
    out.push({
      t: (start + frame / 2) / sampleRate,
      f0: best > 0.55 && bestLag > 0 ? sampleRate / bestLag : null,
      energy: e,
    });
  }
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1]?.f0;
    const b = out[i]?.f0;
    const c = out[i + 1]?.f0;
    if (a && b && c && out[i]) out[i]!.f0 = [a, b, c].sort((x, y) => x - y)[1]!;
  }
  return out;
}

export const semitones = (f: number, ref: number): number => 12 * Math.log2(f / ref);

export function medianOf(xs: number[]): number {
  if (!xs.length) return 0;
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
}

export interface F0Summary {
  medianHz: number;
  startHz: number;
  endHz: number;
  voicedFraction: number;
}

/** Summary over the voiced frames of a track (start/end use the first/last 3 voiced frames). */
export function summarizeF0(track: F0Point[]): F0Summary | null {
  const v = track.filter((p) => p.f0 !== null).map((p) => p.f0 as number);
  if (v.length < 3) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    medianHz: medianOf(v),
    startHz: mean(v.slice(0, 3)),
    endHz: mean(v.slice(-3)),
    voicedFraction: v.length / Math.max(1, track.length),
  };
}

export interface PitchMark {
  /** Sample index inside the analysed segment. */
  pos: number;
  voiced: boolean;
}

/**
 * Place pitch marks: in voiced regions at waveform peaks spaced by the local period (starting from the
 * strongest peak and extending both ways); in unvoiced regions at a fixed 8 ms spacing.
 */
export function pitchMarks(samples: Float32Array, sampleRate: number, track: F0Point[]): PitchMark[] {
  const n = samples.length;
  if (!n) return [];
  const periodAt = (sample: number): number | null => {
    const t = sample / sampleRate;
    let best: F0Point | null = null;
    for (const p of track) if (p.f0 && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
    return best && Math.abs(best.t - t) < 0.03 && best.f0 ? sampleRate / best.f0 : null;
  };
  const marks = new Map<number, boolean>();
  const unvoicedStep = Math.round(0.008 * sampleRate);
  // Voiced anchors: strongest sample in each voiced stretch, then walk outwards.
  const peakNear = (c: number, half: number): number => {
    let bi = Math.min(n - 1, Math.max(0, c));
    let bv = -1;
    for (let i = Math.max(0, c - half); i <= Math.min(n - 1, c + half); i++) {
      const v = samples[i] ?? 0;
      if (v > bv) {
        bv = v;
        bi = i;
      }
    }
    return bi;
  };
  const visited = new Uint8Array(n);
  const voicedIdx = track.filter((p) => p.f0);
  for (const p of voicedIdx) {
    const centre = Math.round(p.t * sampleRate);
    if (centre < 0 || centre >= n || visited[centre]) continue;
    const T = periodAt(centre);
    if (!T) continue;
    let pos = peakNear(centre, Math.round(T / 2));
    const anchor = pos;
    marks.set(pos, true);
    for (const dir of [1, -1] as const) {
      pos = anchor;
      for (let guard = 0; guard < 4000; guard++) {
        const Tl = periodAt(pos) ?? T;
        const pred = pos + dir * Math.round(Tl);
        if (pred < 0 || pred >= n) break;
        const next = peakNear(pred, Math.max(1, Math.round(Tl * 0.25)));
        if (marks.has(next) || (dir === 1 ? next <= pos : next >= pos)) break;
        marks.set(next, true);
        pos = next;
      }
    }
    for (let i = Math.max(0, anchor - Math.round(T * 20)); i < Math.min(n, anchor + Math.round(T * 20)); i++)
      visited[i] = 1;
  }
  const voiced = [...marks.keys()].sort((a, b) => a - b);
  // Unvoiced filler between voiced marks (and at the edges) so every region has marks.
  const all: PitchMark[] = voiced.map((pos) => ({ pos, voiced: true }));
  const filled: PitchMark[] = [];
  const gapFill = (from: number, to: number) => {
    for (let p = from + unvoicedStep; p < to - unvoicedStep / 2; p += unvoicedStep)
      filled.push({ pos: p, voiced: false });
  };
  let prev = -unvoicedStep;
  for (const m of all) {
    // Treat gaps much larger than 2 periods as unvoiced stretches.
    const T = periodAt(m.pos) ?? unvoicedStep;
    if (m.pos - prev > 3 * T) gapFill(prev, m.pos);
    filled.push(m);
    prev = m.pos;
  }
  if (n - prev > 3 * unvoicedStep) gapFill(prev, n);
  if (!all.length) gapFill(-unvoicedStep, n);
  return filled.sort((a, b) => a.pos - b.pos);
}
