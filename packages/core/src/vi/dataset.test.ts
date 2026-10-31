import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTING_KEYS, SUPPORT_CLASS } from '@voxstudio/contracts';
import { findRepoRoot } from '../config';
import { VnUnitAdapter } from './adapter';
import { buildDatasetReport, loadBenchSyllables, COMPONENT_INVENTORY } from './dataset';
import { parseSyllable } from './syllable';
import { UnitDb, buildUnitDb, toWav } from './unitdb';

const SR = 22050;

/** Synthetic harmonic burst: stands in for a recording ONLY to test metadata/coverage arithmetic. */
function burst(ms: number, f0: number): Float32Array {
  const n = Math.round((ms / 1000) * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.sin((Math.PI * i) / n);
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * f0 * h * i) / SR) / h;
    x[i] = 0.3 * env * v;
  }
  return x;
}

/** One syllable per entry, each covering a distinct component set; see COMPONENT_INVENTORY. */
const ALL_SYLLABLES = [
  ...['a', 'ba', 'ca', 'cha', 'da', 'đa', 'ga', 'ghe', 'gia', 'ha', 'kha', 'la', 'ma', 'na', 'nga'],
  ...['nghe', 'nha', 'pha', 'qua', 'ra', 'sa', 'ta', 'tha', 'tra', 'va', 'xa'],
  ...['ăn', 'ân', 'en', 'ên', 'in', 'ý', 'o', 'ô', 'ơ', 'u', 'ư', 'tiên', 'yên', 'mương', 'muốn'],
  ...['mía', 'mưa', 'mua', 'mác', 'ách', 'am', 'an', 'ang', 'anh', 'ấp', 'át', 'ai', 'ay', 'ao', 'au'],
  ...['mà', 'má', 'mả', 'mã', 'mạ'],
];

let work: string;
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'vs-ds-'));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

function build(
  name: string,
  syllables: string[],
  extra: Partial<Parameters<typeof buildUnitDb>[0]> = {},
): UnitDb {
  const dir = path.join(work, name);
  const pad = new Float32Array(Math.round(0.1 * SR));
  const parts: Float32Array[] = [pad];
  const segments: { label: string; start: number; end: number }[] = [];
  let pos = pad.length;
  for (const s of syllables) {
    const b = burst(250, 140 + (s.length % 5) * 10);
    segments.push({ label: s, start: pos, end: pos + b.length });
    parts.push(b, pad);
    pos += b.length + pad.length;
  }
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  buildUnitDb({
    outDir: dir,
    id: name,
    name,
    locale: 'vi-VN',
    dialect: 'southern',
    license: { id: 'test-fixture', notes: 'synthetic test data' },
    recordings: [{ id: 'r0', wav: toWav(all), segments }],
    ...extra,
  });
  return UnitDb.load(dir);
}

describe('inventory definitions', () => {
  it('every required inventory item is a parseable component of some valid syllable', () => {
    expect(ALL_SYLLABLES.every((s) => parseSyllable(s).ok)).toBe(true);
    const parsed = ALL_SYLLABLES.map((s) => parseSyllable(s)).flatMap((p) => (p.ok ? [p.syllable] : []));
    for (const o of COMPONENT_INVENTORY.onsets.required)
      expect(
        parsed.some((p) => p.onset === o),
        `onset ${o}`,
      ).toBe(true);
    for (const o of COMPONENT_INVENTORY.nuclei.required)
      expect(
        parsed.some((p) => p.nucleus === o),
        `nucleus ${o}`,
      ).toBe(true);
    for (const o of COMPONENT_INVENTORY.codas.required)
      expect(
        parsed.some((p) => p.coda === o),
        `coda ${o}`,
      ).toBe(true);
  });
});

describe('dataset report', () => {
  it('reports complete coverage when every component and benchmark syllable has a unit', () => {
    const db = build('complete', ALL_SYLLABLES);
    const r = buildDatasetReport(db, { corpusVersion: 'tiny-1', syllables: ['ma', 'mà', 'ách'] });
    expect(r.units).toBe(ALL_SYLLABLES.length);
    expect(r.components.tones).toMatchObject({ total: 6, covered: 6, missing: [] });
    expect(r.components.onsets.missing).toEqual([]);
    expect(r.components.nuclei.missing).toEqual([]);
    expect(r.components.codas.missing).toEqual([]);
    expect(r.corpus).toMatchObject({ covered: 3, required: 3, coveragePct: 100, missing: [] });
    expect(r.complete).toBe(true);
    expect(r.recording).toMatchObject({ format: 'pcm_s16le', sampleRate: SR, channels: 1 });
    expect(r.recording.totalSeconds).toBeGreaterThan(5);
    expect(r.recording.f0Hz!.median).toBeGreaterThan(100);
    expect(r.recording.rmsDbfs!.median).toBeLessThan(0);
  });

  it('lists missing phonemes and missing corpus syllables instead of claiming completeness', () => {
    const db = build('partial', ['ma', 'mà', 'má']);
    const r = buildDatasetReport(db, { corpusVersion: 'tiny-1', syllables: ['ma', 'xin', 'chào'] });
    expect(r.complete).toBe(false);
    expect(r.components.tones.missing).toEqual(['hoi', 'nga', 'nang']);
    expect(r.components.onsets.missing).toContain('ch');
    expect(r.components.codas.missing).toContain('ng');
    expect(r.corpus).toMatchObject({ covered: 1, required: 3, coveragePct: 33.3, missing: ['xin', 'chào'] });
    expect(r.warnings.join(' ')).toContain('UNIT_MISSING');
    expect(r.singleInstanceSyllables).toBe(3);
  });

  it('is never "complete" without a benchmark list, and says the check was skipped', () => {
    const r = buildDatasetReport(build('nobench', ALL_SYLLABLES), null);
    expect(r.corpus).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.warnings.join(' ')).toContain('Benchmark coverage was not checked');
  });

  it('is deterministic and records dataset identity, checksums, license and attribution', () => {
    const extra = {
      datasetVersion: '2026.1',
      attribution: 'Recorded by A. Speaker, CC BY 4.0',
      recordingNotes: 'Studio, condenser microphone',
      speaker: { gender: 'female' as const, genderVerified: true, notes: 'stated by provider' },
    };
    const a = build('ident', ['ma', 'mà'], extra);
    const r1 = buildDatasetReport(a, null);
    const r2 = buildDatasetReport(UnitDb.load(a.dir), null);
    expect(r2).toEqual(r1);
    expect(r1.datasetVersion).toBe('2026.1');
    expect(r1.license).toMatchObject({
      id: 'test-fixture',
      attribution: 'Recorded by A. Speaker, CC BY 4.0',
    });
    expect(r1.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.unitsSha256).toBe(a.manifest.unitsSha256);
    expect(r1.speaker).toEqual({ gender: 'female', genderVerified: true, region: 'southern' });
    expect(r1.recording.notes).toBe('Studio, condenser microphone');
  });

  it('flags missing provenance and never advertises an unverified gender', () => {
    const r = buildDatasetReport(build('noprov', ['ma']), null);
    expect(r.datasetVersion).toBe('unversioned');
    expect(r.speaker).toMatchObject({ gender: null, genderVerified: false });
    expect(r.warnings.join(' ')).toMatch(/no version label/);
    expect(r.warnings.join(' ')).toMatch(/No speaker record/);
    expect(r.warnings.join(' ')).toMatch(/Test fixture/);
  });

  it('changes the manifest checksum when the dataset changes (audit trail key)', () => {
    const a = buildDatasetReport(build('v1', ['ma'], { datasetVersion: '1' }), null);
    const b = buildDatasetReport(build('v1b', ['ma'], { datasetVersion: '2' }), null);
    expect(a.manifestSha256).not.toBe(b.manifestSha256);
  });

  it('rejects a manifest that states a gender without verification', () => {
    const db = build('badgender', ['ma']);
    const mp = path.join(db.dir, 'manifest.json');
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.speaker = { gender: 'male', genderVerified: false, notes: '' };
    writeFileSync(mp, JSON.stringify(m));
    expect(() => UnitDb.load(db.dir)).toThrow(/genderVerified/);
  });
});

describe('benchmark syllable list', () => {
  it('is generated from vi-bench-1 and contains only valid syllables', () => {
    const list = loadBenchSyllables(findRepoRoot())!;
    expect(list.corpusVersion).toBe('vi-bench-1');
    expect(list.syllables.length).toBeGreaterThan(300);
    expect(list.syllables.every((s) => parseSyllable(s).ok)).toBe(true);
    expect(loadBenchSyllables(path.join(work, 'nowhere'))).toBeNull();
  });
});

describe('VnUnitAdapter voice profile', () => {
  it('derives accent, inventory and dataset from the unit database, not from labels', async () => {
    const db = build('adapter-south', ALL_SYLLABLES, { datasetVersion: '3' });
    const root = path.join(work, 'dbroot');
    mkdirSync(root, { recursive: true });
    const a = new VnUnitAdapter({
      dbRoot: db.dir,
      bench: { corpusVersion: 'tiny-1', syllables: ['ma'] },
    });
    await a.initialize();
    const p = a.getVoiceProfile(db.manifest.id);
    expect(p.region).toBe('southern');
    expect(p.gender).toBeNull();
    expect(p.voiceDatabaseVersion).toBe('3');
    expect(p.inventory.kind).toBe('recorded-units');
    expect(p.inventory.tones).toHaveLength(6);
    expect(p.inventory.recordedSyllables).toBe(ALL_SYLLABLES.length);
    expect(p.dataset?.complete).toBe(true);
    expect(() => a.getVoiceProfile('unknown')).toThrow();
  });

  it('classifies every setting and exposes no control the engine cannot honour as functional', async () => {
    const db = build('adapter-caps', ['ma']);
    const a = new VnUnitAdapter({ dbRoot: db.dir });
    await a.initialize();
    const caps = a.getCapabilities(db.manifest.id);
    for (const k of SETTING_KEYS) expect(['native', 'dsp', 'unsupported']).toContain(caps[k].support);
    expect(SETTING_KEYS.map((k) => SUPPORT_CLASS[caps[k].support])).toContain('ENGINE_NATIVE');
    expect(caps.wordGapMs.support).toBe('unsupported');
    expect(caps.variant.support).toBe('unsupported');
    expect(caps.rate.support).toBe('native');
    expect(caps.volumeDb.support).toBe('dsp');
  });
});

describe('provenance of the source audio (ADR 0007)', () => {
  const generator = { name: 'example-local-tts', version: '1.2', license: 'MIT', localRun: true };

  it('records an AI-generated database with its generator and warns that it is not a human recording', () => {
    const db = build('prov-ai', ['ma'], {
      provenance: { kind: 'ai-generated', generator, notes: 'isolated syllables' },
    });
    const r = buildDatasetReport(db, null);
    expect(r.provenance).toEqual({ kind: 'ai-generated', generator, notes: 'isolated syllables' });
    expect(r.warnings.join(' ')).toContain('generated with AI during development');
    expect(r.warnings.join(' ')).toContain('example-local-tts');
  });

  it('reports older databases as unknown instead of assuming they are human recordings', () => {
    const r = buildDatasetReport(build('prov-none', ['ma']), null);
    expect(r.provenance.kind).toBe('unknown');
    expect(r.warnings.join(' ')).toContain('No provenance record');
  });

  it('refuses AI-generated data without a declared, local, licensed generator', () => {
    expect(() => build('prov-bad1', ['ma'], { provenance: { kind: 'ai-generated' } })).toThrow(
      /generator name, version and license/,
    );
    expect(() =>
      build('prov-bad2', ['ma'], {
        provenance: { kind: 'ai-generated', generator: { ...generator, license: ' ' } },
      }),
    ).toThrow(/generator name, version and license/);
    expect(() =>
      build('prov-bad3', ['ma'], {
        provenance: { kind: 'ai-generated', generator: { ...generator, localRun: false } },
      }),
    ).toThrow(/ran locally/);
  });

  it('rejects a hand-edited manifest that drops the generator declaration', () => {
    const db = build('prov-edit', ['ma'], { provenance: { kind: 'ai-generated', generator } });
    const mp = path.join(db.dir, 'manifest.json');
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    delete m.provenance.generator;
    writeFileSync(mp, JSON.stringify(m));
    expect(() => UnitDb.load(db.dir)).toThrow(/generator name, version and license/);
  });

  it('accepts a human recording declaration', () => {
    const r = buildDatasetReport(
      build('prov-human', ['ma'], { provenance: { kind: 'human-recording' } }),
      null,
    );
    expect(r.provenance).toMatchObject({ kind: 'human-recording', generator: null });
  });
});
