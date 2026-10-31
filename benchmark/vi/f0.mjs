// Dependency-free, deterministic F0 tracker (normalized autocorrelation) and contour features.
// Used only for objective measurements of synthesized audio; it is not a perceptual judgement.

const FRAME_MS = 40;
const HOP_MS = 10;
const F_MIN = 70;
const F_MAX = 450;

/** Returns [{t, f0|null, energy}] per hop. `samples` is Float32Array in [-1, 1]. */
export function trackF0(samples, sampleRate) {
  const frame = Math.round((FRAME_MS / 1000) * sampleRate);
  const hop = Math.round((HOP_MS / 1000) * sampleRate);
  const minLag = Math.floor(sampleRate / F_MAX);
  const maxLag = Math.ceil(sampleRate / F_MIN);
  const out = [];
  let maxEnergy = 0;
  const frames = [];
  for (let start = 0; start + frame + maxLag <= samples.length; start += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += samples[start + i] ** 2;
    e = Math.sqrt(e / frame);
    frames.push({ start, e });
    if (e > maxEnergy) maxEnergy = e;
  }
  for (const { start, e } of frames) {
    let best = 0;
    let bestLag = 0;
    if (e > maxEnergy * 0.1) {
      let r0 = 0;
      for (let i = 0; i < frame; i++) r0 += samples[start + i] ** 2;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let r = 0;
        let rl = 0;
        for (let i = 0; i < frame; i++) {
          r += samples[start + i] * samples[start + i + lag];
          rl += samples[start + i + lag] ** 2;
        }
        const nr = r / Math.sqrt(r0 * rl + 1e-12);
        if (nr > best) {
          best = nr;
          bestLag = lag;
        }
      }
    }
    let f0 = null;
    if (best > 0.55 && bestLag > 0) f0 = sampleRate / bestLag;
    out.push({ t: (start + frame / 2) / sampleRate, f0, energy: e });
  }
  // Octave-error guard + 3-point median smoothing on voiced runs.
  const vals = out.map((o) => o.f0);
  for (let i = 1; i < vals.length - 1; i++) {
    if (vals[i] && vals[i - 1] && vals[i + 1]) {
      const m = [vals[i - 1], vals[i], vals[i + 1]].sort((a, b) => a - b)[1];
      out[i].f0 = m;
    }
  }
  return out;
}

const st = (f, ref) => 12 * Math.log2(f / ref);

/**
 * Contour features of the longest voiced run: semitones relative to the run's median, resampled
 * to 5 points, plus slope, dip position, duration and number of voicing gaps (≤ 3 frames) inside.
 */
export function contourFeatures(track) {
  let best = null;
  let cur = [];
  let gap = 0;
  let gaps = 0;
  let curGaps = 0;
  const flush = () => {
    if (cur.length && (!best || cur.length > best.run.length)) best = { run: cur, gaps: curGaps };
    cur = [];
    curGaps = 0;
  };
  for (const p of track) {
    if (p.f0) {
      if (gap > 0 && gap <= 3 && cur.length) curGaps++;
      else if (gap > 3) flush();
      gap = 0;
      cur.push(p);
    } else {
      gap++;
    }
  }
  flush();
  gaps = best?.gaps ?? 0;
  if (!best || best.run.length < 6) return null;
  const run = best.run;
  const sorted = run.map((p) => p.f0).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const semis = run.map((p) => st(p.f0, median));
  const pts = [0, 0.25, 0.5, 0.75, 1].map((q) => {
    const lo = Math.max(0, Math.round(q * (semis.length - 1)) - 1);
    const hi = Math.min(semis.length - 1, Math.round(q * (semis.length - 1)) + 1);
    const w = semis.slice(lo, hi + 1);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const minIdx = semis.indexOf(Math.min(...semis));
  return {
    voicedMs: Math.round((run[run.length - 1].t - run[0].t) * 1000 + HOP_MS),
    medianHz: Math.round(median),
    points: pts.map((x) => Number(x.toFixed(2))),
    slope: Number((pts[4] - pts[0]).toFixed(2)),
    dipAt: Number((minIdx / Math.max(1, semis.length - 1)).toFixed(2)),
    gaps,
  };
}

/** Euclidean distance between two 5-point contours (semitones). */
export const contourDistance = (a, b) =>
  Math.sqrt(a.points.reduce((s, v, i) => s + (v - b.points[i]) ** 2, 0));
