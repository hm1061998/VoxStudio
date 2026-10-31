import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { medianOf, semitones } from '../audio/f0';
import type { UnitDb, UnitMeta, UnitPosition } from './unitdb';

export interface SelectionTarget {
  key: string;
  position: UnitPosition;
  prevKey: string | null;
  nextKey: string | null;
  /** Wanted pitch of this syllable relative to the speaker's natural level, in semitones (from the prosody plan). */
  desiredPitchSt: number;
  /** Optional wanted duration (ms). */
  targetDurationMs?: number;
}

export interface SelectionWeights {
  context: number;
  position: number;
  pitch: number;
  duration: number;
  join: number;
  /** Candidates kept per target before the dynamic programme. */
  maxCandidates: number;
}

export const DEFAULT_WEIGHTS: SelectionWeights = {
  context: 1,
  position: 1,
  pitch: 0.6,
  duration: 0.5,
  join: 1.2,
  maxCandidates: 24,
};

/** Limits beyond which two units are reported as incompatible at a join. */
export interface JoinLimits {
  maxF0JumpSt: number;
  maxEnergyJumpDb: number;
}
export const DEFAULT_JOIN_LIMITS: JoinLimits = { maxF0JumpSt: 5, maxEnergyJumpDb: 12 };

export interface JoinCompat {
  ok: boolean;
  /** True when both units are consecutive in the same recording (no join is needed). */
  adjacent: boolean;
  f0JumpSt: number;
  energyJumpDb: number;
  reasons: string[];
}

/** Pitch and energy compatibility of `b` following `a`, plus whether they are naturally contiguous. */
export function joinCompatibility(
  a: UnitMeta,
  b: UnitMeta,
  limits: JoinLimits = DEFAULT_JOIN_LIMITS,
): JoinCompat {
  if (a.source === b.source && a.end === b.start)
    return { ok: true, adjacent: true, f0JumpSt: 0, energyJumpDb: 0, reasons: [] };
  const reasons: string[] = [];
  const f0JumpSt = a.f0End > 0 && b.f0Start > 0 ? Math.abs(semitones(b.f0Start, a.f0End)) : 0;
  const energyJumpDb =
    a.rmsEnd > 1e-5 && b.rmsStart > 1e-5 ? Math.abs(20 * Math.log10(b.rmsStart / a.rmsEnd)) : 0;
  if (f0JumpSt > limits.maxF0JumpSt) reasons.push(`pitch jump ${f0JumpSt.toFixed(1)} st`);
  if (energyJumpDb > limits.maxEnergyJumpDb) reasons.push(`energy jump ${energyJumpDb.toFixed(1)} dB`);
  return { ok: reasons.length === 0, adjacent: false, f0JumpSt, energyJumpDb, reasons };
}

export interface Selection {
  units: UnitMeta[];
  joins: JoinCompat[];
  totalCost: number;
}

/** Thrown when the database has no recording for a required syllable. Never substituted. */
export class UnitMissingError extends VoxError {
  constructor(public readonly missing: string[]) {
    super(
      ErrorCodes.UNIT_MISSING,
      `No recorded unit for ${missing.length} syllable${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}.`,
      { missing: missing.slice(0, 50), count: missing.length },
    );
  }
}

function targetCost(
  c: UnitMeta,
  t: SelectionTarget,
  keyMedianF0: number,
  keyMedianDur: number,
  w: SelectionWeights,
): number {
  const ctx = (have: string | null, want: string | null) => (have === want ? 0 : have === null ? 0.4 : 0.7);
  let cost = w.context * (ctx(c.prevKey, t.prevKey) + ctx(c.nextKey, t.nextKey));
  cost += w.position * (c.position === t.position ? 0 : c.position === 'unknown' ? 0.3 : 1);
  if (c.f0Mean > 0 && keyMedianF0 > 0)
    cost += (w.pitch * Math.min(6, Math.abs(semitones(c.f0Mean, keyMedianF0) - t.desiredPitchSt))) / 6;
  if (t.targetDurationMs)
    cost += w.duration * Math.min(1, Math.abs(Math.log(c.durationMs / t.targetDurationMs)));
  else if (t.position === 'final' && keyMedianDur > 0)
    cost += w.duration * 0.5 * Math.max(0, 1 - c.durationMs / keyMedianDur);
  return cost;
}

function joinCost(a: UnitMeta, b: UnitMeta, w: SelectionWeights): number {
  const j = joinCompatibility(a, b);
  if (j.adjacent) return 0;
  const f0Part = a.f0End > 0 && b.f0Start > 0 ? Math.min(1, j.f0JumpSt / 4) : 0.2;
  return w.join * (f0Part + Math.min(1, j.energyJumpDb / 12) * 0.5 + (j.ok ? 0 : 5));
}

/**
 * Deterministic unit selection: lowest-cost path (Viterbi) over the candidates of each target.
 * Ties are broken by unit id. If any target syllable has no candidate the call fails with
 * {@link UnitMissingError}; no other syllable is substituted.
 */
export function selectUnits(
  db: UnitDb,
  targets: SelectionTarget[],
  weights: Partial<SelectionWeights> = {},
): Selection {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const missing = [...new Set(targets.filter((t) => !db.has(t.key)).map((t) => t.key))];
  if (missing.length) throw new UnitMissingError(missing);
  if (!targets.length) return { units: [], joins: [], totalCost: 0 };

  const layers: { unit: UnitMeta; tc: number }[][] = targets.map((t) => {
    const all = db.candidates(t.key);
    const medF0 = medianOf(all.filter((u) => u.f0Mean > 0).map((u) => u.f0Mean));
    const medDur = medianOf(all.map((u) => u.durationMs));
    return all
      .map((unit) => ({ unit, tc: targetCost(unit, t, medF0, medDur, w) }))
      .sort((a, b) => a.tc - b.tc || a.unit.id - b.unit.id)
      .slice(0, w.maxCandidates);
  });

  const cost: number[][] = [];
  const back: number[][] = [];
  layers.forEach((layer, i) => {
    cost[i] = [];
    back[i] = [];
    layer.forEach((cand, j) => {
      if (i === 0) {
        cost[i]![j] = cand.tc;
        back[i]![j] = -1;
        return;
      }
      let best = Infinity;
      let arg = 0;
      layers[i - 1]!.forEach((prev, k) => {
        const c = cost[i - 1]![k]! + joinCost(prev.unit, cand.unit, w);
        if (c < best - 1e-12) {
          best = c;
          arg = k;
        }
      });
      cost[i]![j] = best + cand.tc;
      back[i]![j] = arg;
    });
  });
  const last = cost[layers.length - 1]!;
  let bestJ = 0;
  last.forEach((c, j) => {
    if (c < last[bestJ]! - 1e-12) bestJ = j;
  });
  const path: number[] = [];
  for (let i = layers.length - 1, j = bestJ; i >= 0; i--) {
    path.unshift(j);
    j = back[i]![j]!;
  }
  const units = path.map((j, i) => layers[i]![j]!.unit);
  const joins = units.slice(1).map((u, i) => joinCompatibility(units[i]!, u));
  return { units, joins, totalCost: last[bestJ]! };
}
