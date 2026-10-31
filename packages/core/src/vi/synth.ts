import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { medianOf, semitones } from '../audio/f0';
import { applyGainWithHeadroom, CANONICAL_SAMPLE_RATE } from '../audio/dsp';
import { psola } from '../audio/psola';
import { dbToLinear, msToSamples } from '../audio/wav';
import { planProsody, type ProsodyControls, type SyllablePlan } from './prosody';
import { PROFILES } from './profiles';
import { selectUnits, type Selection, type SelectionWeights } from './select';
import { analyzeVietnamese } from './text';
import type { UnitDb, UnitMeta } from './unitdb';

const SR = CANONICAL_SAMPLE_RATE;

export interface SynthOptions {
  controls?: Partial<ProsodyControls>;
  userLexicon?: Record<string, string>;
  weights?: Partial<SelectionWeights>;
  /** "hard" disables crossfades and join-offset search (QA comparison only). */
  joinMode?: 'smooth' | 'hard';
}

export interface SynthMetrics {
  phrases: number;
  syllables: number;
  joins: number;
  incompatibleJoins: number;
  maxJoinF0JumpSt: number;
  /** Step size at each join relative to the neighbouring signal's typical step (1 ≈ inaudible, large = click). */
  discontinuity: number[];
  maxDiscontinuity: number;
  unitIds: number[];
  warnings: string[];
}

export interface SynthResult {
  /** Mono Float32 audio at the canonical rate, trimmed and loudness-normalised. */
  samples: Float32Array;
  durationMs: number;
  /** Start/end (ms) of every syllable in the output. */
  timeline: { text: string; startMs: number; endMs: number }[];
  metrics: SynthMetrics;
}

class Buffer32 {
  data = new Float32Array(SR * 2);
  length = 0;
  ensure(extra: number) {
    if (this.length + extra <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, this.length + extra));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  append(x: Float32Array, from = 0) {
    this.ensure(x.length - from);
    this.data.set(x.subarray(from), this.length);
    this.length += x.length - from;
  }
  silence(n: number) {
    this.ensure(n);
    this.data.fill(0, this.length, this.length + n);
    this.length += n;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

/** Overlap-add `next` onto the end of `acc`, choosing the start offset that best matches the waveform. Returns the join position. */
function joinSmooth(acc: Buffer32, next: Float32Array, mode: 'smooth' | 'hard'): number {
  if (mode === 'hard' || acc.length < 32 || next.length < 32) {
    const pos = acc.length;
    acc.append(next);
    return pos;
  }
  const X = Math.min(msToSamples(6, SR), Math.floor(Math.min(acc.length, next.length) * 0.25));
  const tail = acc.data.subarray(acc.length - X, acc.length);
  let bestS = 0;
  let bestNcc = -Infinity;
  const maxS = Math.min(msToSamples(2, SR), next.length - X - 1);
  for (let s = 0; s <= maxS; s++) {
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < X; i++) {
      const p = tail[i] ?? 0;
      const q = next[s + i] ?? 0;
      dot += p * q;
      a += p * p;
      b += q * q;
    }
    const ncc = dot / Math.sqrt(a * b + 1e-12);
    if (ncc > bestNcc + 1e-9) {
      bestNcc = ncc;
      bestS = s;
    }
  }
  const base = acc.length - X;
  for (let i = 0; i < X; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / X);
    acc.data[base + i] = (acc.data[base + i] ?? 0) * (1 - w) + (next[bestS + i] ?? 0) * w;
  }
  acc.append(next, bestS + X);
  return base + Math.floor(X / 2);
}

function stepRatio(x: Float32Array, pos: number): number {
  const w = msToSamples(1, SR);
  let maxStep = 0;
  for (let i = Math.max(1, pos - w); i < Math.min(x.length, pos + w); i++)
    maxStep = Math.max(maxStep, Math.abs((x[i] ?? 0) - (x[i - 1] ?? 0)));
  let sum = 0;
  let n = 0;
  for (let i = Math.max(1, pos - msToSamples(10, SR)); i < pos - msToSamples(2, SR); i++) {
    sum += Math.abs((x[i] ?? 0) - (x[i - 1] ?? 0));
    n++;
  }
  const ref = n ? sum / n : 0;
  return ref > 1e-6 ? maxStep / ref : 0;
}

const frameRms = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, b - a));
};

/** Remove leading/trailing silence (frames below −50 dBFS), keeping 10 ms of margin. Returns the removed head length. */
function trimSilence(x: Float32Array): { samples: Float32Array; head: number } {
  const frame = msToSamples(5, SR);
  const thr = dbToLinear(-50);
  let a = 0;
  while (a + frame < x.length && frameRms(x, a, a + frame) < thr) a += frame;
  let b = x.length;
  while (b - frame > a && frameRms(x, b - frame, b) < thr) b -= frame;
  const margin = msToSamples(10, SR);
  const start = Math.max(0, a - margin);
  const end = Math.min(x.length, b + margin);
  return { samples: x.slice(start, end), head: start };
}

/**
 * Full Vietnamese concatenative synthesis:
 * text → rule-based analysis → prosody plan → deterministic unit selection (per phrase) →
 * TD-PSOLA prosody → smooth joins → silence trimming → loudness normalisation.
 */
export function synthesizeVietnamese(db: UnitDb, text: string, opts: SynthOptions = {}): SynthResult {
  const profile = PROFILES[db.manifest.dialect];
  const analysis = analyzeVietnamese(text, { profile, userLexicon: opts.userLexicon });
  if (analysis.unresolved.length)
    throw new VoxError(
      ErrorCodes.UNRESOLVED_TOKENS,
      `These words cannot be read by the Vietnamese engine: ${analysis.unresolved.slice(0, 10).join(', ')}. Add them to the pronunciation dictionary.`,
      { tokens: analysis.unresolved.slice(0, 50) },
    );
  const plans = planProsody(analysis.phrases, opts.controls);
  if (!plans.some((p) => p.syllables.length))
    throw new VoxError(ErrorCodes.EMPTY_TEXT, 'There is no speakable Vietnamese text.');

  // Selection per phrase (joins across a pause are irrelevant). selectUnits throws UnitMissingError for gaps.
  const selections: Selection[] = plans.map((p) =>
    selectUnits(
      db,
      p.syllables.map((s) => ({
        key: s.token.syllable.text,
        position: s.position,
        prevKey: s.prevKey,
        nextKey: s.nextKey,
        desiredPitchSt: s.desiredPitchSt,
      })),
      opts.weights,
    ),
  );

  const allRms = db.units.map((u) => u.rms).filter((r) => r > 0);
  const refRms = medianOf(allRms);
  const out = new Buffer32();
  const joinPositions: number[] = [];
  const timeline: { text: string; startMs: number; endMs: number }[] = [];
  const unitIds: number[] = [];
  let maxF0Jump = 0;
  let incompatible = 0;
  const warnings = [...analysis.warnings];
  const mode = opts.joinMode ?? 'smooth';

  plans.forEach((plan, pi) => {
    const sel = selections[pi]!;
    const phraseBuf = new Buffer32();
    let prevEndHz = 0;
    plan.syllables.forEach((s, i) => {
      const unit: UnitMeta = sel.units[i]!;
      unitIds.push(unit.id);
      // Continuity: partially compensate the pitch mismatch with the previous unit (bounded, tone-preserving).
      let offset = s.offsetSt;
      if (i > 0 && prevEndHz > 0 && unit.f0Start > 0) {
        const natural = unit.f0Start * Math.pow(2, offset / 12);
        const mismatch = semitones(prevEndHz, natural);
        offset += Math.max(-2.5, Math.min(2.5, 0.5 * mismatch));
      }
      const raw = db.audio(unit);
      let mean = 0;
      for (const v of raw) mean += v;
      mean /= Math.max(1, raw.length);
      const x = raw.map((v) => v - mean);
      const marks = unit.marks.map(([pos, v]) => ({ pos, voiced: v === 1 }));
      const y = psola(x, marks, {
        durationFactor: s.durationFactor,
        pitchShiftSt: (t) => offset + s.slopeSt * (t - 0.5),
      });
      const unitGainDb =
        unit.rms > 0 ? Math.max(-4, Math.min(4, 0.5 * 20 * Math.log10(refRms / unit.rms))) : 0;
      const g = dbToLinear(unitGainDb + s.gainDb);
      for (let k = 0; k < y.length; k++) y[k] = (y[k] ?? 0) * g;
      const startAt = phraseBuf.length;
      if (i > 0) {
        const j = sel.joins[i - 1]!;
        maxF0Jump = Math.max(maxF0Jump, j.f0JumpSt);
        if (!j.ok) incompatible++;
        joinPositions.push(out.length + joinSmooth(phraseBuf, y, mode));
      } else phraseBuf.append(y);
      timeline.push({
        text: s.token.syllable.text,
        startMs: out.length + startAt,
        endMs: out.length + phraseBuf.length,
      });
      prevEndHz = unit.f0End > 0 ? unit.f0End * Math.pow(2, (offset + s.slopeSt / 2) / 12) : 0;
    });
    // Short edge fades remove clicks at phrase starts and ends.
    const pv = phraseBuf.view();
    const fade = Math.min(msToSamples(3, SR), Math.floor(pv.length / 4));
    for (let k = 0; k < fade; k++) {
      pv[k] = (pv[k] ?? 0) * (k / fade);
      pv[pv.length - 1 - k] = (pv[pv.length - 1 - k] ?? 0) * (k / fade);
    }
    out.append(pv);
    if (plan.pauseAfterMs > 0 && pi < plans.length - 1) out.silence(msToSamples(plan.pauseAfterMs, SR));
  });

  const raw = out.view();
  const disc = joinPositions.map((p) => stepRatio(raw, p));
  const { samples: trimmed, head } = trimSilence(raw);
  // Loudness: bring the active speech RMS to −20 dBFS; headroom protection guarantees no clipping.
  const frame = msToSamples(20, SR);
  const rmsFrames: number[] = [];
  for (let a = 0; a + frame <= trimmed.length; a += frame) rmsFrames.push(frameRms(trimmed, a, a + frame));
  const maxFrame = Math.max(...rmsFrames, 1e-9);
  const active = rmsFrames.filter((r) => r > maxFrame * 0.1);
  const activeRms = active.length ? Math.sqrt(active.reduce((s, r) => s + r * r, 0) / active.length) : 0;
  const gainDb = activeRms > 1e-6 ? Math.max(-24, Math.min(24, 20 * Math.log10(0.1 / activeRms))) : 0;
  const normalised = applyGainWithHeadroom(trimmed, gainDb);
  if (normalised.attenuationDb > 0)
    warnings.push(
      `Output was attenuated by ${normalised.attenuationDb.toFixed(1)} dB to prevent clipping (requested gain ${gainDb.toFixed(1)} dB).`,
    );
  const toMs = (n: number) => Math.round(((n - head) / SR) * 1000);
  return {
    samples: normalised.samples,
    durationMs: Math.round((normalised.samples.length / SR) * 1000),
    timeline: timeline.map((t) => ({
      text: t.text,
      startMs: Math.max(0, toMs(t.startMs)),
      endMs: Math.max(0, toMs(t.endMs)),
    })),
    metrics: {
      phrases: plans.length,
      syllables: unitIds.length,
      joins: joinPositions.length,
      incompatibleJoins: incompatible,
      maxJoinF0JumpSt: Number(maxF0Jump.toFixed(2)),
      discontinuity: disc.map((d) => Number(d.toFixed(2))),
      maxDiscontinuity: Number(Math.max(0, ...disc).toFixed(2)),
      unitIds,
      warnings,
    },
  };
}

export type { SyllablePlan };
