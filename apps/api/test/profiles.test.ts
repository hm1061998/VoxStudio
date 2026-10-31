import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTING_KEYS, SUPPORT_CLASS } from '@voxstudio/contracts';
import { buildUnitDb, createEngineRegistry, findRepoRoot, toWav } from '@voxstudio/core';
import { CatalogService } from '../dist/catalog/catalog.service';
import { Logger } from '../dist/common/infra';
import { as, createHarness, register, type Harness, type TestUser } from './harness';

const SR = 22050;
const VOICE = 'vnunit:vi-south-test';
let h: Harness;
let alice: TestUser;
let tmp: string;
let catalog: CatalogService;
let unitsDir: string;

function burst(ms: number, f0: number): Float32Array {
  const n = Math.round((ms / 1000) * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++)
    x[i] = 0.3 * Math.sin((Math.PI * i) / n) * Math.sin((2 * Math.PI * f0 * i) / SR);
  return x;
}

/** Synthetic tone bursts stand in for recordings: this test checks catalog/profile/audit plumbing only. */
function buildFixture(version: string): void {
  const labels = ['ma', 'mà', 'má'];
  const pad = new Float32Array(Math.round(0.1 * SR));
  const parts: Float32Array[] = [pad];
  const segments: { label: string; start: number; end: number }[] = [];
  let pos = pad.length;
  for (const l of labels) {
    const b = burst(250, 150);
    segments.push({ label: l, start: pos, end: pos + b.length });
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
    outDir: path.join(unitsDir, 'vi-south-test'),
    id: 'vi-south-test',
    name: 'test',
    locale: 'vi-VN',
    dialect: 'southern',
    datasetVersion: version,
    license: { id: 'test-fixture', notes: 'synthetic' },
    recordings: [{ id: 'r0', wav: toWav(all), segments }],
  });
}

async function newCatalog(): Promise<CatalogService> {
  const config = { ...h.config, repoRoot: tmp, vnUnitDbDir: unitsDir };
  const c = new CatalogService(h.prisma, createEngineRegistry(config), config, new Logger('error'));
  await c.refresh();
  return c;
}

beforeAll(async () => {
  h = await createHarness();
  alice = await register(h, `alice-${randomUUID().slice(0, 6)}@example.test`);
  const repo = findRepoRoot();
  tmp = mkdtempSync(path.join(tmpdir(), 'vs-prof-'));
  unitsDir = path.join(tmp, 'units');
  mkdirSync(path.join(tmp, 'config'), { recursive: true });
  for (const f of ['voice-qa-report.json', 'vi-bench-syllables.json'])
    copyFileSync(path.join(repo, 'config', f), path.join(tmp, 'config', f));
  const allow = JSON.parse(readFileSync(path.join(repo, 'config', 'voice-allowlist.json'), 'utf8'));
  // The allowlist deliberately claims "northern"; the voice data is southern and must win.
  allow.push({
    id: VOICE,
    engineId: 'vnunit',
    nativeId: 'vi-south-test',
    locale: 'vi-VN',
    displayName: 'Vietnamese (test)',
    accent: 'northern',
  });
  writeFileSync(path.join(tmp, 'config', 'voice-allowlist.json'), JSON.stringify(allow));
  writeFileSync(
    path.join(tmp, 'config', 'voice-qa-report.vnunit.json'),
    JSON.stringify({
      engineId: 'vnunit',
      engineVersion: '0.1.0',
      corpusVersion: 'test',
      generatedAt: new Date().toISOString(),
      results: { [VOICE]: { status: 'passed', checks: [], sampleText: 'Xin chào.' } },
    }),
  );
  buildFixture('1');
  catalog = await newCatalog();
});
afterAll(async () => {
  await h?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('voice profiles (HTTP, eSpeak voices)', () => {
  it('returns a full profile for the Northern Vietnamese eSpeak voice', async () => {
    const r = await as(h, alice).get('/voices/espeak:vi/profile');
    expect(r.status).toBe(200);
    const p = r.body.data;
    expect(p).toMatchObject({
      id: 'espeak:vi',
      locale: 'vi-VN',
      region: 'northern',
      accent: 'northern',
      gender: null,
      engineName: expect.stringContaining('eSpeak'),
      dataset: null,
      datasetHistory: [],
      inventory: { kind: 'rule-based' },
      defaults: { rate: 1 },
    });
    expect(p.sample.text.length).toBeGreaterThan(0);
    expect(p.license).toBeTruthy();
    expect(p.validation.state).toMatch(/automated-passed|reviewed/);
  });

  it('classifies every setting exactly as its capability declares', async () => {
    const p = (await as(h, alice).get('/voices/espeak:vi/profile')).body.data;
    for (const k of SETTING_KEYS) expect(p.controls[k]).toBe(SUPPORT_CLASS[p.capabilities[k].support]);
    expect(Object.values(p.controls)).toEqual(expect.arrayContaining(['ENGINE_NATIVE', 'DSP_DERIVED']));
  });

  it('offers Northern, Central and Southern only as separate, installed voices', async () => {
    const vi = (await as(h, alice).get('/voices?locale=vi')).body.data as { accent: string; id: string }[];
    expect(vi.map((v) => v.accent).sort()).toEqual(['central', 'northern', 'southern']);
    expect(new Set(vi.map((v) => v.id)).size).toBe(3);
  });

  it('has no dataset endpoint content for rule-based voices and 404s unknown voices', async () => {
    expect((await as(h, alice).get('/voices/espeak:vi/dataset')).status).toBe(404);
    expect((await as(h, alice).get('/voices/espeak:nope/profile')).status).toBe(404);
  });

  it('requires authentication', async () => {
    expect((await h.http().get('/api/v1/voices/espeak:vi/profile')).status).toBe(401);
  });

  it('rejects a voice for a text locale it does not speak', async () => {
    const c = catalog;
    await expect(c.resolveSelectable('espeak:vi', 'en-US')).rejects.toMatchObject({
      code: 'VOICE_LOCALE_UNSUPPORTED',
    });
    await expect(c.resolveSelectable('espeak:vi', 'vi-VN')).resolves.toMatchObject({
      voice: { id: 'espeak:vi' },
    });
  });
});

describe('recorded-unit voice profile (vnunit, synthetic fixture)', () => {
  it('takes the accent from the voice data, not the allowlist label', async () => {
    const p = await catalog.getProfile(VOICE, true);
    expect(p.accent).toBe('southern');
    expect(p.region).toBe('southern');
    expect(p.inventory.kind).toBe('recorded-units');
    expect(p.inventory.recordedSyllables).toBe(3);
    expect(p.dataset).toMatchObject({ units: 3, datasetVersion: '1', complete: false });
    expect(p.dataset!.components.tones.missing).toEqual(['hoi', 'nga', 'nang']);
    expect(p.voiceDatabaseVersion).toBe('1');
    expect(p.validation.state).toBe('automated-passed');
  });

  it('classifies unsupported controls and keeps the unverified engine unselectable', async () => {
    const p = await catalog.getProfile(VOICE, true);
    expect(p.controls.wordGapMs).toBe('UNSUPPORTED');
    expect(p.controls.variant).toBe('UNSUPPORTED');
    expect(p.controls.rate).toBe('ENGINE_NATIVE');
    expect(p.controls.volumeDb).toBe('DSP_DERIVED');
    expect(p.enabled).toBe(false);
    await expect(catalog.resolveSelectable(VOICE, 'vi-VN')).rejects.toMatchObject({
      code: 'ENGINE_DISABLED',
    });
    expect((await catalog.listVoices({ locale: 'vi' })).some((v) => v.id === VOICE)).toBe(false);
  });

  it('keeps an append-only dataset audit trail keyed by manifest checksum', async () => {
    const rows = () => h.prisma.ttsVoiceDataset.findMany({ where: { voiceId: VOICE } });
    expect(await rows()).toHaveLength(1);
    await catalog.refresh();
    expect(await rows()).toHaveLength(1); // unchanged dataset: no new record
    buildFixture('2');
    const c2 = await newCatalog();
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.manifestSha256)).size).toBe(2);
    const p = await c2.getProfile(VOICE, true);
    expect(p.datasetHistory.map((x) => x.datasetVersion).sort()).toEqual(['1', '2']);
    expect(p.dataset!.datasetVersion).toBe('2');
    const report = all.find((r) => r.datasetVersion === '1')!.reportJson as { units: number };
    expect(report.units).toBe(3);
  });

  it('serves the dataset report to admins through the API shape', async () => {
    const d = await catalog.getProfile(VOICE, true);
    expect(d.dataset!.license).toMatchObject({ id: 'test-fixture' });
    expect(d.dataset!.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
