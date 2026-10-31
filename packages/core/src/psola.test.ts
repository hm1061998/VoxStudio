import { describe, expect, it } from 'vitest';
import { pitchMarks, semitones, summarizeF0, trackF0 } from './audio/f0';
import { psola } from './audio/psola';

const SR = 22050;
/** Harmonic test signal with a constant F0 (a stand-in for a voiced vowel). */
function voiced(f0: number, ms: number): Float32Array {
  const n = Math.round((SR * ms) / 1000);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] =
      0.4 * Math.sin(2 * Math.PI * f0 * t) +
      0.2 * Math.sin(4 * Math.PI * f0 * t) +
      0.1 * Math.sin(6 * Math.PI * f0 * t);
  }
  return x;
}
const f0Of = (x: Float32Array) => summarizeF0(trackF0(x, SR))!.medianHz;

describe('F0 tracking and pitch marks', () => {
  it('measures a known F0 within 2%', () => {
    for (const f of [110, 150, 220]) expect(Math.abs(f0Of(voiced(f, 400)) - f) / f).toBeLessThan(0.02);
  });
  it('places marks about one period apart in voiced signals', () => {
    const x = voiced(150, 300);
    const marks = pitchMarks(x, SR, trackF0(x, SR)).filter((m) => m.voiced);
    expect(marks.length).toBeGreaterThan(30);
    const gaps = marks.slice(1).map((m, i) => m.pos - marks[i]!.pos);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(Math.abs(mean - SR / 150) / (SR / 150)).toBeLessThan(0.05);
  });
});

describe('TD-PSOLA', () => {
  const x = voiced(150, 400);
  const marks = pitchMarks(x, SR, trackF0(x, SR));
  it('keeps length and pitch when unmodified', () => {
    const y = psola(x, marks, { durationFactor: 1, pitchShiftSt: () => 0 });
    expect(Math.abs(y.length - x.length)).toBeLessThan(5);
    expect(Math.abs(semitones(f0Of(y), 150))).toBeLessThan(0.5);
  });
  it('shifts pitch by the requested semitones without changing duration', () => {
    for (const st of [-4, 3, 6]) {
      const y = psola(x, marks, { durationFactor: 1, pitchShiftSt: () => st });
      expect(Math.abs(semitones(f0Of(y), 150) - st)).toBeLessThan(0.6);
    }
  });
  it('changes duration without changing pitch', () => {
    for (const a of [0.7, 1.5, 2]) {
      const y = psola(x, marks, { durationFactor: a, pitchShiftSt: () => 0 });
      expect(Math.abs(y.length / x.length - a)).toBeLessThan(0.02);
      expect(Math.abs(semitones(f0Of(y), 150))).toBeLessThan(0.6);
    }
  });
  it('follows a rising contour', () => {
    const y = psola(x, marks, { durationFactor: 1, pitchShiftSt: (t) => 6 * t });
    const s = summarizeF0(trackF0(y, SR))!;
    expect(semitones(s.endHz, s.startHz)).toBeGreaterThan(3);
  });
  it('is deterministic and keeps level stable', () => {
    const a = psola(x, marks, { durationFactor: 1.2, pitchShiftSt: () => 2 });
    const b = psola(x, marks, { durationFactor: 1.2, pitchShiftSt: () => 2 });
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    const rms = (s: Float32Array) => Math.sqrt(s.reduce((q, v) => q + v * v, 0) / s.length);
    expect(Math.abs(rms(a) / rms(x) - 1)).toBeLessThan(0.15);
  });
});
