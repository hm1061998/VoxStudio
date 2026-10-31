import type { Boundary, Phrase, SyllableToken } from './text';
import type { Tone } from './syllable';
import type { UnitPosition } from './unitdb';

/**
 * Deterministic prosody controls. Every control maps to a measurable change in the generated audio
 * (duration via PSOLA, pitch via PSOLA, silence via exact sample counts). The planner shifts and tilts
 * the recorded tone contours; it never replaces them, and falling tones (huyền, nặng) are never given a
 * rising slope, so tone identity is preserved. This is rule-based intonation, not emotional acting.
 */
export interface ProsodyControls {
  /** Speaking rate; 1 = recorded pace. */
  rate: number;
  /** Global pitch offset in semitones. */
  pitchSt: number;
  /** Scales declination, final contours and emphasis (0 = flat, 1 = default, 2 = wide). */
  pitchRange: number;
  /** Scales phrase-boundary pauses (0 = none). */
  pauseScale: number;
  /** Rising final contour for questions ("?"). */
  questionIntonation: boolean;
  /** Scales emphasis effects for `*word*`. */
  emphasisStrength: number;
}

export const DEFAULT_CONTROLS: ProsodyControls = {
  rate: 1,
  pitchSt: 0,
  pitchRange: 1,
  pauseScale: 1,
  questionIntonation: true,
  emphasisStrength: 1,
};

export const PAUSE_MS: Record<Boundary, number> = { none: 0, minor: 220, major: 450, paragraph: 700, end: 0 };
const ELLIPSIS_PAUSE_MS = 600;
const SLOPE_TONES: ReadonlySet<Tone> = new Set<Tone>(['ngang', 'sac', 'hoi', 'nga']);
const MAX_OFFSET_ST = 8;

export interface SyllablePlan {
  token: SyllableToken;
  phraseIndex: number;
  indexInPhrase: number;
  phraseLength: number;
  position: UnitPosition;
  prevKey: string | null;
  nextKey: string | null;
  /** Pitch offset for the whole syllable in semitones (includes the global control). */
  offsetSt: number;
  /** Added linear pitch change across the syllable in semitones (tone-safe). */
  slopeSt: number;
  /** Pitch wanted relative to the speaker's natural level, used to choose among recorded units. */
  desiredPitchSt: number;
  durationFactor: number;
  gainDb: number;
}

export interface PhrasePlan {
  syllables: SyllablePlan[];
  /** Silence after the phrase, ms. */
  pauseAfterMs: number;
  boundary: Boundary;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function planProsody(phrases: Phrase[], controls: Partial<ProsodyControls> = {}): PhrasePlan[] {
  const c = { ...DEFAULT_CONTROLS, ...controls };
  const range = clamp(c.pitchRange, 0, 2.5);
  const rate = clamp(c.rate, 0.4, 2.5);
  return phrases.map((ph, phraseIndex) => {
    const N = ph.tokens.length;
    const syllables = ph.tokens.map((token, i): SyllablePlan => {
      const u = N > 1 ? i / (N - 1) : 0;
      const last = i === N - 1;
      let contour = (ph.type === 'question' ? -1 : -2) * range * u;
      let slope = 0;
      let df = 1 / rate;
      let gain = 0;
      const tone = token.syllable.tone;
      if (last) {
        const strong = ph.boundary !== 'minor';
        df *= strong ? 1.35 : 1.25;
        if (ph.type === 'question' && c.questionIntonation) {
          contour += 3 * range;
          if (SLOPE_TONES.has(tone)) slope = 2 * range;
        } else if (ph.type === 'exclamation') {
          contour += 1 * range;
          df *= 1.1;
        } else if (ph.boundary === 'minor') contour += 0.5 * range;
        else contour -= 1.5 * range;
      } else if (i === N - 2 && ph.type === 'question' && c.questionIntonation) contour += 1 * range;
      if (token.emphasis) {
        const e = c.emphasisStrength;
        contour += 2 * range * e;
        df *= 1 + 0.15 * e;
        gain += 2 * e;
      }
      return {
        token,
        phraseIndex,
        indexInPhrase: i,
        phraseLength: N,
        position: N === 1 ? 'isolated' : i === 0 ? 'initial' : last ? 'final' : 'medial',
        prevKey: i > 0 ? ph.tokens[i - 1]!.syllable.text : null,
        nextKey: i < N - 1 ? ph.tokens[i + 1]!.syllable.text : null,
        offsetSt: clamp(c.pitchSt + contour, -MAX_OFFSET_ST - 12, MAX_OFFSET_ST + 12),
        slopeSt: slope,
        desiredPitchSt: contour,
        durationFactor: df,
        gainDb: gain,
      };
    });
    const base = ph.terminal === '…' ? ELLIPSIS_PAUSE_MS : PAUSE_MS[ph.boundary];
    return { syllables, pauseAfterMs: Math.round(base * clamp(c.pauseScale, 0, 4)), boundary: ph.boundary };
  });
}
