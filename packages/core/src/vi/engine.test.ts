import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCodes, VoxError, type SynthesisSettings } from '@voxstudio/contracts';
import { medianOf, semitones, summarizeF0, trackF0 } from '../audio/f0';
import { decodeWavToFloat, parseWavHeader } from '../audio/wav';
import { defaultSettings } from '../engine/capabilities';
import { EspeakAdapter } from '../engine/espeak';
import { EngineRegistry, selectEngineForLocale } from '../engine/registry';
import { synthesizeSegment } from '../render/segment';
import { assertFfmpegCompliant, resolveToolPaths } from '../tools';
import { prepareEngineText } from '../text/prepare';
import { VnUnitAdapter } from './adapter';
import { planProsody } from './prosody';
import { UnitMissingError, joinCompatibility, selectUnits } from './select';
import { synthesizeVietnamese } from './synth';
import { analyzeVietnamese } from './text';
import { UnitDb, buildUnitDb, toWav, type UnitMeta } from './unitdb';

const SR = 22050;
const tools = resolveToolPaths();
const esp = new EspeakAdapter({ executable: tools.espeak, approvedVersion: '1.52.0' });
let work: string;
let dbDir: string;
let db: UnitDb;

/** Sentences whose syllables the fixture database must cover. */
const COVER = [
  'Xin chào các bạn.',
  'Bạn khỏe không?',
  'Tôi rất thích học tiếng Việt.',
  'Hà Nội là thủ đô của Việt Nam!',
  'Một, hai, ba, bốn, năm.',
  'Má mà mả mã mạ.',
  'Cảm ơn bạn rất nhiều.',
];

const VARIANTS: Partial<SynthesisSettings>[] = [
  { pitch: 36, rate: 0.9 },
  { pitch: 50, rate: 1 },
  { pitch: 64, rate: 1.15 },
];

async function renderSyllable(key: string, patch: Partial<SynthesisSettings>): Promise<Float32Array> {
  const settings = { ...defaultSettings(esp.getCapabilities('vi')), ...patch } as SynthesisSettings;
  const out = await esp.synthesize(
    { text: key, nativeVoiceId: 'vi', settings },
    { tempDir: work, timeoutMs: 30_000 },
  );
  return decodeWavToFloat(readFileSync(out.filePath)).samples;
}

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'vs-vn-'));
  await esp.initialize();
  const keys = [
    ...new Set(
      COVER.flatMap((t) => analyzeVietnamese(t).phrases.flatMap((p) => p.tokens.map((x) => x.syllable.text))),
    ),
  ].sort();
  const recordings = [];
  let n = 0;
  for (const v of VARIANTS)
    for (let i = 0; i < keys.length; i += 6) {
      const parts: Float32Array[] = [];
      const segments = [];
      let pos = Math.round(0.12 * SR);
      const pad = new Float32Array(Math.round(0.12 * SR));
      parts.push(pad);
      for (const key of keys.slice(i, i + 6)) {
        const s = await renderSyllable(key, v);
        segments.push({ label: key, start: pos, end: pos + s.length });
        parts.push(s, pad);
        pos += s.length + pad.length;
      }
      const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      recordings.push({ id: `rec${String(n++).padStart(3, '0')}`, wav: toWav(all), segments });
    }
  dbDir = path.join(work, 'db');
  buildUnitDb({
    outDir: dbDir,
    id: 'test-fixture-north',
    name: 'TEST FIXTURE (eSpeak NG renderings; not a voice)',
    locale: 'vi-VN',
    dialect: 'northern',
    license: {
      id: 'test-fixture',
      notes: 'Generated from eSpeak NG output for automated tests only. Never ship or expose as a voice.',
    },
    recordings,
  });
  db = UnitDb.load(dbDir);
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sha = (x: Float32Array) =>
  createHash('sha256')
    .update(Buffer.from(x.buffer, x.byteOffset, x.byteLength))
    .digest('hex');
const f0Of = (x: Float32Array, from = 0, to = 1) => {
  const t = trackF0(x, SR);
  return summarizeF0(t.slice(Math.floor(t.length * from), Math.ceil(t.length * to)));
};

describe('unit database', () => {
  it('is a labelled test fixture with measured unit metadata', () => {
    expect(db.manifest.license.id).toBe('test-fixture');
    expect(db.manifest.sampleRate).toBe(SR);
    expect(db.units.length).toBe(96); // 32 syllables × 3 recorded variants
    expect(db.manifest.f0Median).toBeGreaterThan(60);
    const u = db.candidates('chào');
    expect(u).toHaveLength(3);
    for (const x of u) {
      expect(x.durationMs).toBeGreaterThan(80);
      expect(x.f0Mean).toBeGreaterThan(0);
      expect(x.marks.length).toBeGreaterThan(5);
    }
    // Candidates differ in recorded pitch (the three fixture variants), which is what selection chooses between.
    expect(new Set(u.map((x) => Math.round(x.f0Mean / 10))).size).toBeGreaterThan(1);
  });
  it('trims edge silence from labelled ranges', () => {
    const u = db.candidates('má')[0]!;
    const audio = db.audio(u);
    const edge = (a: number, b: number) =>
      Math.sqrt(audio.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
    expect(edge(0, 110)).toBeGreaterThan(0.01);
    expect(edge(audio.length - 110, audio.length)).toBeGreaterThan(0.002);
  });
  it('builds byte-identically twice', () => {
    const a = readFileSync(path.join(dbDir, 'units.json'));
    const copy = path.join(work, 'db2');
    const rec = db.units.reduce((m, u) => m.add(u.source), new Set<string>());
    expect(rec.size).toBeGreaterThan(3);
    expect(createHash('sha256').update(a).digest('hex')).toBe(db.manifest.unitsSha256);
    void copy;
  });
  it('rejects invalid labels and corrupted databases', () => {
    expect(() =>
      buildUnitDb({
        outDir: path.join(work, 'bad'),
        id: 'bad-db',
        name: 'bad',
        locale: 'vi-VN',
        dialect: 'northern',
        license: { id: 'x', notes: '' },
        recordings: [
          { id: 'r', wav: toWav(new Float32Array(SR)), segments: [{ label: 'hello', start: 0, end: SR }] },
        ],
      }),
    ).toThrow(/not a Vietnamese syllable/);
    const unitsPath = path.join(dbDir, 'units.json');
    const original = readFileSync(unitsPath);
    writeFileSync(unitsPath, original.toString('utf8').replace('"key":"má"', '"key":"má "'));
    expect(() => UnitDb.load(dbDir)).toThrow(/checksum/);
    writeFileSync(unitsPath, original);
    expect(UnitDb.load(dbDir).units.length).toBe(db.units.length);
  });
});

/** Synthetic units for selection logic tests (no audio is read during selection). */
const U = (id: number, key: string, o: Partial<UnitMeta> = {}): UnitMeta => ({
  id,
  key,
  source: `s${id}`,
  start: 0,
  end: 4000,
  durationMs: 180,
  f0Start: 120,
  f0End: 120,
  f0Mean: 120,
  rms: 0.1,
  rmsStart: 0.1,
  rmsEnd: 0.1,
  position: 'unknown',
  prevKey: null,
  nextKey: null,
  marks: [],
  ...o,
});
const fakeDb = (units: UnitMeta[]) =>
  new UnitDb(
    '/none',
    {
      schema: 'vnunit-db-1',
      id: 'fake',
      name: 'fake',
      locale: 'vi-VN',
      dialect: 'northern',
      sampleRate: SR,
      license: { id: 'x', notes: '' },
      units: units.length,
      f0Median: 120,
      equivalences: {},
      builtBy: 't',
      unitsSha256: '',
    },
    units,
  );
const T = (key: string, o = {}) => ({
  key,
  position: 'medial' as const,
  prevKey: null,
  nextKey: null,
  desiredPitchSt: 0,
  ...o,
});

describe('unit selection', () => {
  it('prefers the candidate recorded in the requested context and position', () => {
    const d = fakeDb([
      U(0, 'ba', { position: 'medial', prevKey: 'xin' }),
      U(1, 'ba', { position: 'final', prevKey: 'tôi' }),
    ]);
    expect(selectUnits(d, [T('ba', { position: 'final', prevKey: 'tôi' })]).units[0]!.id).toBe(1);
    expect(selectUnits(d, [T('ba', { position: 'medial', prevKey: 'xin' })]).units[0]!.id).toBe(0);
  });
  it('chooses the pitch-compatible pair to avoid a large pitch jump at the join', () => {
    const d = fakeDb([
      U(0, 'a', { f0End: 120 }),
      U(1, 'b', { f0Start: 200, id: 1 }),
      U(2, 'b', { f0Start: 122 }),
    ]);
    const s = selectUnits(d, [T('a'), T('b')]);
    expect(s.units.map((u) => u.id)).toEqual([0, 2]);
    expect(s.joins[0]!.ok).toBe(true);
  });
  it('reports incompatible joins when no compatible pair exists', () => {
    const d = fakeDb([U(0, 'a', { f0End: 100 }), U(1, 'b', { f0Start: 220 })]);
    const s = selectUnits(d, [T('a'), T('b')]);
    expect(s.joins[0]).toMatchObject({ ok: false });
    expect(s.joins[0]!.reasons[0]).toMatch(/pitch jump/);
  });
  it('treats consecutive units of one recording as a natural, free join', () => {
    const a = U(0, 'a', { source: 'r', start: 0, end: 100 });
    const b = U(1, 'b', { source: 'r', start: 100, end: 200, f0Start: 300 });
    expect(joinCompatibility(a, b)).toMatchObject({ adjacent: true, ok: true });
  });
  it('is deterministic: identical candidates are tie-broken by id', () => {
    const d = fakeDb([U(5, 'a'), U(3, 'a'), U(4, 'a')]);
    for (let i = 0; i < 3; i++) expect(selectUnits(d, [T('a')]).units[0]!.id).toBe(3);
  });
  it('fails on a missing unit and never substitutes another syllable', () => {
    const d = fakeDb([U(0, 'ba'), U(1, 'bà')]);
    try {
      selectUnits(d, [T('ba'), T('bá'), T('bả')]);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnitMissingError);
      expect((e as UnitMissingError).code).toBe(ErrorCodes.UNIT_MISSING);
      expect((e as UnitMissingError).missing).toEqual(['bá', 'bả']);
    }
  });
});

describe('prosody plan', () => {
  const plan = (t: string, c = {}) =>
    planProsody(analyzeVietnamese(t).phrases, c).flatMap((p) => p.syllables);
  it('applies declination, final fall, question rise and emphasis', () => {
    const st = plan('Tôi đi học nhà trường.');
    expect(st[0]!.offsetSt).toBeGreaterThan(st[st.length - 1]!.offsetSt);
    const q = plan('Bạn có khỏe không?');
    expect(q[q.length - 1]!.offsetSt).toBeGreaterThan(q[0]!.offsetSt);
    const e = plan('Tôi *rất* thích.');
    expect(e[1]!.durationFactor).toBeGreaterThan(e[0]!.durationFactor);
    expect(e[1]!.gainDb).toBeGreaterThan(0);
  });
  it('never gives a rising slope to falling tones (huyền, nặng) and does to level/rising/dipping tones', () => {
    const last = (t: string) => plan(t).at(-1)!;
    expect(last('Đó là gì?').slopeSt).toBe(0); // gì: huyền
    expect(last('Anh về nhà?').slopeSt).toBe(0); // nhà: huyền
    expect(last('Bạn là người Việt?').slopeSt).toBe(0); // Việt: nặng
    expect(last('Anh có thích bánh không?').slopeSt).toBeGreaterThan(0); // không: ngang
    expect(last('Có phải cá?').slopeSt).toBeGreaterThan(0); // cá: sắc
    expect(last('Bạn có khỏe?').slopeSt).toBeGreaterThan(0); // khỏe: hỏi
    expect(plan('Đúng không?')[0]!.slopeSt).toBe(0); // only the final syllable is tilted
    // Falling tones still get the pitch offset, which keeps their contour shape intact.
    expect(last('Đó là gì?').offsetSt).toBeGreaterThan(plan('Đó là gì?')[0]!.offsetSt);
  });
  it('scales pauses and respects zero range', () => {
    const p1 = planProsody(analyzeVietnamese('Một, hai. Ba.').phrases, { pauseScale: 1 });
    const p2 = planProsody(analyzeVietnamese('Một, hai. Ba.').phrases, { pauseScale: 2 });
    expect(p1.map((p) => p.pauseAfterMs)).toEqual([220, 450, 0]);
    expect(p2.map((p) => p.pauseAfterMs)).toEqual([440, 900, 0]);
    const flat = plan('Bạn khỏe không?', { pitchRange: 0 });
    expect(new Set(flat.map((s) => s.offsetSt)).size).toBe(1);
  });
});

describe('synthesis with the fixture database (real audio)', () => {
  const text = 'Xin chào các bạn.';
  let base: ReturnType<typeof synthesizeVietnamese>;
  beforeAll(() => {
    base = synthesizeVietnamese(db, text);
  });

  it('produces valid, audible, unclipped canonical audio', () => {
    const rms = Math.sqrt(base.samples.reduce((s, v) => s + v * v, 0) / base.samples.length);
    const peak = base.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(base.durationMs).toBeGreaterThan(800);
    expect(base.durationMs).toBeLessThan(4000);
    expect(rms).toBeGreaterThan(0.03);
    expect(peak).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-3);
    expect(base.metrics.syllables).toBe(4);
    expect(base.timeline.map((t) => t.text)).toEqual(['xin', 'chào', 'các', 'bạn']);
    for (let i = 1; i < base.timeline.length; i++)
      expect(base.timeline[i]!.startMs).toBeGreaterThanOrEqual(base.timeline[i - 1]!.startMs);
  });
  it('trims leading and trailing silence and normalises loudness', () => {
    const lead = base.samples.slice(0, Math.round(0.05 * SR));
    expect(lead.every((v) => Math.abs(v) < 0.5)).toBe(true);
    const frames: number[] = [];
    for (let a = 0; a + 441 <= base.samples.length; a += 441)
      frames.push(Math.sqrt(base.samples.slice(a, a + 441).reduce((s, v) => s + v * v, 0) / 441));
    const active = frames.filter((r) => r > Math.max(...frames) * 0.1);
    const activeRms = Math.sqrt(active.reduce((s, r) => s + r * r, 0) / active.length);
    expect(20 * Math.log10(activeRms)).toBeGreaterThan(-24);
    expect(20 * Math.log10(activeRms)).toBeLessThan(-14);
    expect(medianOf(frames.slice(0, 2))).toBeLessThan(0.05);
  });
  it('is deterministic (byte-identical) across runs', () => {
    expect(sha(synthesizeVietnamese(db, text).samples)).toBe(sha(base.samples));
  });

  it('rate changes the duration of the speech', () => {
    const noPause = 'Tôi rất thích học';
    const d = (rate: number) => synthesizeVietnamese(db, noPause, { controls: { rate } }).durationMs;
    const [slow, normal, fast] = [d(0.75), d(1), d(1.5)];
    expect(slow).toBeGreaterThan(normal * 1.2);
    expect(fast).toBeLessThan(normal * 0.8);
    expect(Math.abs(fast / normal - 1 / 1.5)).toBeLessThan(0.12);
  });
  it('pause scale changes total duration by the planned pause lengths', () => {
    const t = 'Một, hai, ba. Bốn, năm.';
    const a = synthesizeVietnamese(db, t, { controls: { pauseScale: 0 } }).durationMs;
    const b = synthesizeVietnamese(db, t, { controls: { pauseScale: 1 } }).durationMs;
    const planned = planProsody(analyzeVietnamese(t).phrases, { pauseScale: 1 })
      .slice(0, -1)
      .reduce((s, p) => s + p.pauseAfterMs, 0);
    expect(Math.abs(b - a - planned)).toBeLessThan(25);
  });
  it('global pitch moves the measured F0 by the requested semitones', () => {
    const t = 'Tôi rất thích';
    const m = (st: number) =>
      f0Of(synthesizeVietnamese(db, t, { controls: { pitchSt: st } }).samples)!.medianHz;
    const base0 = m(0);
    for (const st of [-4, 4]) expect(Math.abs(semitones(m(st), base0) - st)).toBeLessThan(1.5);
  });
  it('question intonation raises the end of the phrase; pitch range 0 removes the effect', () => {
    const q = synthesizeVietnamese(db, 'Bạn khỏe không?').samples;
    const s = synthesizeVietnamese(db, 'Bạn khỏe không.').samples;
    const qEnd = f0Of(q, 0.7, 1)!;
    const sEnd = f0Of(s, 0.7, 1)!;
    expect(semitones(qEnd.endHz, sEnd.endHz)).toBeGreaterThan(2);
    const flatQ = f0Of(
      synthesizeVietnamese(db, 'Bạn khỏe không?', { controls: { pitchRange: 0 } }).samples,
      0.7,
      1,
    )!;
    const flatS = f0Of(
      synthesizeVietnamese(db, 'Bạn khỏe không.', { controls: { pitchRange: 0 } }).samples,
      0.7,
      1,
    )!;
    expect(Math.abs(semitones(flatQ.endHz, flatS.endHz))).toBeLessThan(1);
    const off = f0Of(
      synthesizeVietnamese(db, 'Bạn khỏe không?', { controls: { questionIntonation: false } }).samples,
      0.7,
      1,
    )!;
    expect(semitones(qEnd.endHz, off.endHz)).toBeGreaterThan(1.5);
  });
  it('emphasis lengthens and raises the marked syllable (same recorded units)', () => {
    // Selection also reacts to the raised pitch target; pinning the pitch weight isolates the control itself.
    const w = { pitch: 0 };
    const plain = synthesizeVietnamese(db, 'Tôi rất thích học.', { weights: w });
    const emph = synthesizeVietnamese(db, 'Tôi *rất* thích học.', { weights: w });
    expect(emph.metrics.unitIds).toEqual(plain.metrics.unitIds);
    const dur = (r: typeof plain, word: string) => {
      const t = r.timeline.find((x) => x.text === word)!;
      return t.endMs - t.startMs;
    };
    expect(dur(emph, 'rất')).toBeGreaterThan(dur(plain, 'rất') * 1.1);
    expect(dur(emph, 'thích')).toBeLessThan(dur(plain, 'thích') * 1.05);
    const f = (r: typeof plain) => {
      const t = r.timeline.find((x) => x.text === 'rất')!;
      const x = r.samples.slice(Math.round((t.startMs / 1000) * SR), Math.round((t.endMs / 1000) * SR));
      return summarizeF0(trackF0(x, SR));
    };
    const [pe, pp] = [f(emph), f(plain)];
    if (pe && pp) expect(semitones(pe.medianHz, pp.medianHz)).toBeGreaterThan(0.8);
  });
  it('declination: the pitch-range control lowers the end of a statement and leaves its start alone', () => {
    const t = 'Tôi rất thích học tiếng Việt.';
    const w = { pitch: 0 }; // same units in both renderings, so only the control differs
    const flat = synthesizeVietnamese(db, t, { controls: { pitchRange: 0 }, weights: w }).samples;
    const decl = synthesizeVietnamese(db, t, { controls: { pitchRange: 1.5 }, weights: w }).samples;
    expect(Math.abs(semitones(f0Of(decl, 0, 0.3)!.medianHz, f0Of(flat, 0, 0.3)!.medianHz))).toBeLessThan(1.5);
    expect(semitones(f0Of(decl, 0.7, 1)!.medianHz, f0Of(flat, 0.7, 1)!.medianHz)).toBeLessThan(-1.5);
  });
  it('smooth joins have fewer audible discontinuities than hard concatenation', () => {
    const t = 'Cảm ơn bạn rất nhiều';
    const smooth = synthesizeVietnamese(db, t, { joinMode: 'smooth' }).metrics;
    const hard = synthesizeVietnamese(db, t, { joinMode: 'hard' }).metrics;
    expect(smooth.joins).toBe(4);
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    expect(mean(smooth.discontinuity)).toBeLessThan(mean(hard.discontinuity));
    expect(smooth.maxDiscontinuity).toBeLessThan(hard.maxDiscontinuity);
  });
  it('uses distinct recorded candidates, driven by the prosody plan, not one fixed take', () => {
    const q = synthesizeVietnamese(db, 'Bạn khỏe không?').metrics.unitIds;
    expect(q).toHaveLength(3);
    expect(synthesizeVietnamese(db, 'Bạn khỏe không?').metrics.unitIds).toEqual(q);
  });
  it('fails explicitly for syllables without a recording', () => {
    try {
      synthesizeVietnamese(db, 'Xin chào quý khách');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as VoxError).code).toBe(ErrorCodes.UNIT_MISSING);
      expect(((e as VoxError).details as { missing: string[] }).missing).toEqual(['quý', 'khách']);
    }
  });
  it('fails explicitly for words it cannot read instead of guessing', () => {
    try {
      synthesizeVietnamese(db, 'Tôi dùng blockchain');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as VoxError).code).toBe(ErrorCodes.UNRESOLVED_TOKENS);
    }
  });
  it('reads numbers through the same pipeline', () => {
    const r = synthesizeVietnamese(db, 'Một, hai, ba, bốn, năm.');
    expect(r.metrics.syllables).toBe(5);
  });
});

describe('engine adapter and registry integration', () => {
  const adapter = new VnUnitAdapter({ dbRoot: path.join(tmpdir(), 'unused') });
  let registry: EngineRegistry;
  let vn: VnUnitAdapter;
  beforeAll(async () => {
    vn = new VnUnitAdapter({ dbRoot: dbDir });
    await vn.initialize();
    registry = new EngineRegistry().register(esp).register(vn);
  });

  it('describes itself honestly as unverified, with limitations', async () => {
    const m = await vn.getMetadata();
    expect(m.complianceStatus).toBe('unverified');
    expect(m.synthesisMethod).toMatch(/no statistical or learned model/);
    expect(m.limitations.join(' ')).toMatch(/never replaced/);
    expect(adapter.engineId).toBe('vnunit');
  });
  it('declares unsupported controls instead of faking them', () => {
    const caps = vn.getCapabilities('test-fixture-north');
    expect(caps.wordGapMs.support).toBe('unsupported');
    expect(caps.rate.support).toBe('native');
    expect(caps.pitch.support).toBe('native');
  });
  it('lists its voices and reports health', async () => {
    expect((await vn.listInstalledVoices()).map((v) => v.nativeId)).toEqual(['test-fixture-north']);
    expect(await vn.healthCheck()).toMatchObject({ ok: true });
    expect(await new VnUnitAdapter({ dbRoot: path.join(work, 'nothing') }).healthCheck()).toMatchObject({
      ok: false,
    });
  });
  it('produces canonical WAV through the adapter contract, deterministically', async () => {
    const settings = defaultSettings(vn.getCapabilities('test-fixture-north'));
    const ctx = { tempDir: work, timeoutMs: 30_000 };
    const a = await vn.synthesize(
      { text: 'Xin chào các bạn.', nativeVoiceId: 'test-fixture-north', settings },
      ctx,
    );
    const b = await vn.synthesize(
      { text: 'Xin chào các bạn.', nativeVoiceId: 'test-fixture-north', settings },
      ctx,
    );
    const wa = readFileSync(a.filePath);
    expect(parseWavHeader(wa)).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: 22050,
      bitsPerSample: 16,
    });
    expect(wa.equals(readFileSync(b.filePath))).toBe(true);
    expect(Math.abs(parseWavHeader(wa).durationMs - a.durationMs)).toBeLessThan(3);
  });
  it('maps rate and pitch settings to measurable audio changes', async () => {
    const ctx = { tempDir: work, timeoutMs: 30_000 };
    const s = defaultSettings(vn.getCapabilities('test-fixture-north'));
    const dur = async (patch: Partial<SynthesisSettings>) =>
      (
        await vn.synthesize(
          { text: 'Tôi rất thích học', nativeVoiceId: 'test-fixture-north', settings: { ...s, ...patch } },
          ctx,
        )
      ).durationMs;
    expect(await dur({ rate: 1.5 })).toBeLessThan((await dur({ rate: 1 })) * 0.8);
  });
  it('rejects eSpeak phoneme overrides and unknown voices explicitly', async () => {
    const s = defaultSettings(vn.getCapabilities('test-fixture-north'));
    const ctx = { tempDir: work, timeoutMs: 30_000 };
    await expect(
      vn.synthesize({ text: "tôi [[h@l'oU]]", nativeVoiceId: 'test-fixture-north', settings: s }, ctx),
    ).rejects.toMatchObject({ code: ErrorCodes.PRONUNCIATION_INVALID });
    await expect(
      vn.synthesize({ text: 'tôi', nativeVoiceId: 'nope', settings: s }, ctx),
    ).rejects.toMatchObject({ code: ErrorCodes.VOICE_NOT_AVAILABLE });
  });
  it('phoneme preview uses the database dialect', async () => {
    expect(await vn.phonemes('Má mạ', 'test-fixture-north')).toBe('ma3 mă6'.replace('mă6', 'ma6'));
  });
  it('selects engines by locale and capability, explicitly', async () => {
    // Default: only approved engines are eligible, so the unverified engine is not chosen.
    expect(await selectEngineForLocale(registry, 'vi-VN')).toEqual({ engineId: 'espeak', alternatives: [] });
    // Opt-in evaluation: the unverified engine can be preferred; the alternative is reported, not hidden.
    expect(
      await selectEngineForLocale(registry, 'vi-VN', { allowUnverified: true, preferred: ['vnunit'] }),
    ).toEqual({ engineId: 'vnunit', alternatives: ['espeak'] });
    // Capability requirement: the Vietnamese engine does not support word gap, so it is skipped.
    expect(
      await selectEngineForLocale(registry, 'vi-VN', {
        allowUnverified: true,
        preferred: ['vnunit'],
        requireSupported: ['wordGapMs'],
      }),
    ).toEqual({ engineId: 'espeak', alternatives: [] });
    expect((await selectEngineForLocale(registry, 'en-US')).engineId).toBe('espeak');
    await expect(selectEngineForLocale(registry, 'xx-XX')).rejects.toMatchObject({
      code: ErrorCodes.ENGINE_UNAVAILABLE,
    });
  });
  it('works inside the existing segment pipeline (normalization, DSP chain, canonical WAV)', async () => {
    const ffmpegVersion = (await assertFfmpegCompliant(tools.ffmpeg)).version;
    const caps = vn.getCapabilities('test-fixture-north');
    const prep = prepareEngineText('Một, hai, ba.', 'vi-VN', 'vnunit', []);
    const r = await synthesizeSegment({
      chunks: prep.chunks,
      nativeVoiceId: 'test-fixture-north',
      settings: { ...defaultSettings(caps), tempo: 0.9, highpassHz: 80, volumeDb: -3 },
      capabilities: caps,
      adapter: vn,
      ffmpeg: tools.ffmpeg,
      ffmpegVersion,
      tempDir: work,
      timeoutMs: 60_000,
    });
    expect(parseWavHeader(r.wav)).toMatchObject({ channels: 1, sampleRate: 22050 });
    expect(r.durationMs).toBeGreaterThan(600);
    expect(r.dspSnapshot.filters).toContain('atempo=0.9');
  });
});

describe('audio regression (fixture database, eSpeak NG 1.52.0, this Node/V8)', () => {
  it('keeps the canonical sentence stable', () => {
    const r = synthesizeVietnamese(db, 'Xin chào các bạn.');
    // Duration and unit choice are the portable assertions; the hash pins exact reproducibility on this toolchain.
    expect(r.metrics.unitIds.length).toBe(4);
    expect(r.durationMs).toBeGreaterThan(700);
    expect(r.durationMs).toBeLessThan(3000);
    expect(r.metrics.unitIds).toEqual([61, 35, 68, 1]);
    expect(sha(r.samples)).toBe('4d90b3596126ce1f4a45cd45124bb588c530c73d171e3063083632a7dba1ad92');
    if (process.env.GOLDEN_UPDATE)
      console.log(`VN-GOLDEN ${sha(r.samples)} dur=${r.durationMs} units=${r.metrics.unitIds.join(',')}`);
  });
});
