import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { medianOf, pitchMarks, summarizeF0, trackF0 } from '../audio/f0';
import { decodeWavToFloat, encodeWavPcm16 } from '../audio/wav';
import { CANONICAL_SAMPLE_RATE } from '../audio/dsp';
import { parseSyllable } from './syllable';

/**
 * Unit inventory: the phonetic unit is the **tonal syllable** (orthographic key such as "chào").
 * Vietnamese is monosyllabic and tonal, so a syllable unit carries its tone contour intact and avoids
 * concatenating inside the tone-bearing part of the syllable. Each recorded instance of a syllable is
 * one candidate unit with the metadata below, supplied or measured by the database builder.
 */
export const UNIT_DB_SCHEMA = 'vnunit-db-1';

export type UnitPosition = 'initial' | 'medial' | 'final' | 'isolated' | 'unknown';

export interface UnitMeta {
  id: number;
  /** Tonal syllable key (lower-case NFC), e.g. "chào". */
  key: string;
  /** Source recording id (file `audio/<source>.wav`). */
  source: string;
  /** Sample range inside the source recording (end exclusive). */
  start: number;
  end: number;
  durationMs: number;
  /** F0 at the start/end/mean of the unit in Hz; 0 when unvoiced. */
  f0Start: number;
  f0End: number;
  f0Mean: number;
  rms: number;
  /** RMS of the first and last 10 ms (used for join energy matching). */
  rmsStart: number;
  rmsEnd: number;
  position: UnitPosition;
  /** Syllables recorded immediately before/after (null at an edge or when unknown). */
  prevKey: string | null;
  nextKey: string | null;
  /** Pitch marks relative to `start`: [sampleOffset, voiced(1)/unvoiced(0)]. */
  marks: [number, 0 | 1][];
}

/**
 * Origin of the recordings (ADR 0007). AI-generated audio is allowed as development-time source data only
 * when the generator is declared, ran locally and has a stated license; it is never part of the application.
 */
export interface Provenance {
  kind: 'human-recording' | 'ai-generated';
  generator?: { name: string; version: string; license: string; localRun: boolean };
  notes?: string;
}

export function validateProvenance(p: Provenance | undefined): string | null {
  if (!p) return null;
  if (p.kind !== 'human-recording' && p.kind !== 'ai-generated') return 'provenance.kind is invalid';
  if (p.kind === 'ai-generated') {
    const g = p.generator;
    if (!g || !g.name?.trim() || !g.version?.trim() || !g.license?.trim())
      return 'ai-generated data must declare generator name, version and license';
    if (g.localRun !== true)
      return 'ai-generated data must come from a generator that ran locally (localRun: true)';
  }
  return null;
}

export interface UnitDbManifest {
  schema: typeof UNIT_DB_SCHEMA;
  /** Voice id fragment: lower-case letters, digits, "-" or "_". */
  id: string;
  name: string;
  locale: string;
  dialect: 'northern' | 'central' | 'southern';
  sampleRate: number;
  license: { id: string; notes: string };
  /** Dataset release label chosen by the data provider/builder (older databases lack it). */
  datasetVersion?: string;
  /** Credit line required by the license; empty when the license requires none. */
  attribution?: string;
  /** Who was recorded. `genderVerified` is true only when the provider stated it. */
  speaker?: { gender: 'female' | 'male' | null; genderVerified: boolean; notes: string };
  /** Free-text recording conditions supplied by the provider (device, room, session). */
  recordingNotes?: string;
  /** Origin of the audio; databases without it are reported as "unknown". */
  provenance?: Provenance;
  units: number;
  f0Median: number;
  /** Syllable keys the recording speaker merges, e.g. {"trà": "chà"} (data-provider supplied, verified by a native speaker). */
  equivalences: Record<string, string>;
  builtBy: string;
  unitsSha256: string;
}

export class UnitDb {
  private readonly byKey = new Map<string, UnitMeta[]>();
  private readonly audioCache = new Map<string, Float32Array>();

  constructor(
    readonly dir: string,
    readonly manifest: UnitDbManifest,
    readonly units: UnitMeta[],
  ) {
    for (const u of units) {
      const k = this.canonicalKey(u.key);
      const list = this.byKey.get(k) ?? [];
      list.push(u);
      this.byKey.set(k, list);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => a.id - b.id);
  }

  /** Load and validate a unit database directory. Fails loudly on any inconsistency. */
  static load(dir: string): UnitDb {
    const bad = (msg: string): never => {
      throw new VoxError(ErrorCodes.ENGINE_UNAVAILABLE, `Unit database is invalid: ${msg}`, {
        dir: path.basename(dir),
      });
    };
    const manifestPath = path.join(dir, 'manifest.json');
    const unitsPath = path.join(dir, 'units.json');
    if (!existsSync(manifestPath) || !existsSync(unitsPath)) bad('manifest.json or units.json missing');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as UnitDbManifest;
    const raw = readFileSync(unitsPath);
    if (manifest.schema !== UNIT_DB_SCHEMA) bad(`unsupported schema ${String(manifest.schema)}`);
    if (!/^[a-z0-9_-]{2,40}$/.test(manifest.id)) bad('manifest id must match [a-z0-9_-]{2,40}');
    if (manifest.sampleRate !== CANONICAL_SAMPLE_RATE)
      bad(`sample rate ${manifest.sampleRate} is not supported yet (expected ${CANONICAL_SAMPLE_RATE})`);
    if (createHash('sha256').update(raw).digest('hex') !== manifest.unitsSha256)
      bad('units.json checksum mismatch');
    const units = JSON.parse(raw.toString('utf8')) as UnitMeta[];
    if (units.length !== manifest.units) bad('unit count differs from manifest');
    for (const u of units) {
      if (!parseSyllable(u.key).ok) bad(`unit ${u.id} has invalid syllable key "${u.key}"`);
      if (!existsSync(path.join(dir, 'audio', `${u.source}.wav`))) bad(`audio for unit ${u.id} is missing`);
    }
    const pv = validateProvenance(manifest.provenance);
    if (pv) bad(pv);
    if (manifest.speaker?.gender && !manifest.speaker.genderVerified)
      bad('speaker.gender may only be set when genderVerified is true');
    const db = new UnitDb(dir, manifest, units);
    db.manifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    return db;
  }

  /** SHA-256 of manifest.json as loaded; part of the dataset audit record. */
  manifestSha256 = '';

  canonicalKey(key: string): string {
    return this.manifest.equivalences[key] ?? key;
  }

  candidates(key: string): UnitMeta[] {
    return this.byKey.get(this.canonicalKey(key)) ?? [];
  }

  has(key: string): boolean {
    return this.candidates(key).length > 0;
  }

  /** Audio samples of one unit (Float32, canonical rate). */
  audio(u: UnitMeta): Float32Array {
    let src = this.audioCache.get(u.source);
    if (!src) {
      src = decodeWavToFloat(readFileSync(path.join(this.dir, 'audio', `${u.source}.wav`))).samples;
      this.audioCache.set(u.source, src);
    }
    return src.slice(u.start, u.end);
  }
}

export interface RecordingSpec {
  /** Recording id: becomes `audio/<id>.wav`. */
  id: string;
  /** PCM16 mono WAV at the canonical sample rate. */
  wav: Buffer;
  /** Labelled syllables in time order. Boundaries come from the data provider; no automatic alignment is performed. */
  segments: { label: string; start: number; end: number; position?: UnitPosition }[];
}

export interface BuildSpec {
  outDir: string;
  id: string;
  name: string;
  locale: string;
  dialect: UnitDbManifest['dialect'];
  license: UnitDbManifest['license'];
  datasetVersion?: string;
  attribution?: string;
  speaker?: UnitDbManifest['speaker'];
  recordingNotes?: string;
  provenance?: Provenance;
  equivalences?: Record<string, string>;
  recordings: RecordingSpec[];
}

const rmsOf = (x: Float32Array, a = 0, b = x.length): number => {
  let s = 0;
  const n = Math.max(1, b - a);
  for (let i = a; i < b; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / n);
};

/** Shrink a labelled range to where the signal is audible (edge silence removal), keeping at least 40 ms. */
function trimRange(x: Float32Array, start: number, end: number, sr: number): [number, number] {
  const win = Math.round(0.005 * sr);
  let peak = 0;
  for (let i = start; i + win <= end; i += win) peak = Math.max(peak, rmsOf(x, i, i + win));
  const thr = peak * 0.05;
  let s = start;
  let e = end;
  const min = Math.round(0.04 * sr);
  while (e - s > min && s + win < e && rmsOf(x, s, s + win) < thr) s += win;
  while (e - s > min && e - win > s && rmsOf(x, e - win, e) < thr) e -= win;
  return [s, e];
}

/**
 * Build a unit database from labelled recordings. Deterministic: identical input produces identical
 * output bytes. Labels must be well-formed Vietnamese syllables; anything else is rejected.
 */
export function buildUnitDb(spec: BuildSpec): UnitDbManifest {
  const sr = CANONICAL_SAMPLE_RATE;
  const pv = validateProvenance(spec.provenance);
  if (pv) throw new Error(pv);
  mkdirSync(path.join(spec.outDir, 'audio'), { recursive: true });
  const units: UnitMeta[] = [];
  const f0s: number[] = [];
  for (const rec of spec.recordings) {
    const { samples, info } = decodeWavToFloat(rec.wav);
    if (info.sampleRate !== sr || info.channels !== 1)
      throw new Error(`recording ${rec.id}: expected mono ${sr} Hz`);
    writeFileSync(path.join(spec.outDir, 'audio', `${rec.id}.wav`), rec.wav);
    rec.segments.forEach((seg, i) => {
      const parsed = parseSyllable(seg.label);
      if (!parsed.ok)
        throw new Error(
          `recording ${rec.id}: label "${seg.label}" is not a Vietnamese syllable (${parsed.reason})`,
        );
      const [start, end] = trimRange(samples, seg.start, Math.min(seg.end, samples.length), sr);
      const slice = samples.slice(start, end);
      const track = trackF0(slice, sr);
      const f = summarizeF0(track);
      const marks = pitchMarks(slice, sr, track).map((m) => [m.pos, m.voiced ? 1 : 0] as [number, 0 | 1]);
      const tenMs = Math.round(0.01 * sr);
      const meta: UnitMeta = {
        id: units.length,
        key: parsed.syllable.text,
        source: rec.id,
        start,
        end,
        durationMs: Math.round(((end - start) / sr) * 1000),
        f0Start: f ? Math.round(f.startHz * 10) / 10 : 0,
        f0End: f ? Math.round(f.endHz * 10) / 10 : 0,
        f0Mean: f ? Math.round(f.medianHz * 10) / 10 : 0,
        rms: Number(rmsOf(slice).toFixed(5)),
        rmsStart: Number(rmsOf(slice, 0, tenMs).toFixed(5)),
        rmsEnd: Number(rmsOf(slice, Math.max(0, slice.length - tenMs)).toFixed(5)),
        position: seg.position ?? 'unknown',
        prevKey: rec.segments[i - 1]
          ? (parseSyllable(rec.segments[i - 1]!.label) as { syllable: { text: string } }).syllable.text
          : null,
        nextKey: rec.segments[i + 1]
          ? (parseSyllable(rec.segments[i + 1]!.label) as { syllable: { text: string } }).syllable.text
          : null,
        marks,
      };
      if (meta.f0Mean) f0s.push(meta.f0Mean);
      units.push(meta);
    });
  }
  const unitsJson = JSON.stringify(units);
  writeFileSync(path.join(spec.outDir, 'units.json'), unitsJson);
  const manifest: UnitDbManifest = {
    schema: UNIT_DB_SCHEMA,
    id: spec.id,
    name: spec.name,
    locale: spec.locale,
    dialect: spec.dialect,
    sampleRate: sr,
    license: spec.license,
    ...(spec.datasetVersion ? { datasetVersion: spec.datasetVersion } : {}),
    ...(spec.attribution !== undefined ? { attribution: spec.attribution } : {}),
    ...(spec.speaker ? { speaker: spec.speaker } : {}),
    ...(spec.recordingNotes ? { recordingNotes: spec.recordingNotes } : {}),
    ...(spec.provenance ? { provenance: spec.provenance } : {}),
    units: units.length,
    f0Median: medianOf(f0s),
    equivalences: spec.equivalences ?? {},
    builtBy: 'voxstudio buildUnitDb 1',
    unitsSha256: createHash('sha256').update(unitsJson).digest('hex'),
  };
  writeFileSync(path.join(spec.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Re-encode a Float32 buffer as a canonical WAV (helper for builders and tests). */
export const toWav = (x: Float32Array): Buffer => encodeWavPcm16(x, CANONICAL_SAMPLE_RATE, 1).wav;
