import { describe, expect, it } from 'vitest';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { buildCatalog, isSelectable, type AllowlistEntry, type QaReport } from './catalog/catalog';
import { EngineRegistry } from './engine/registry';
import type { TtsEngineAdapter } from './engine/types';

/** Minimal fake engine used only in tests; never registered by `createEngineRegistry`. */
function fake(id: string, healthy = true): TtsEngineAdapter {
  return {
    engineId: id,
    initialize: async () => undefined,
    getMetadata: async () => ({
      id,
      name: id,
      version: '1.0',
      synthesisMethod: 'test',
      complianceStatus: 'approved' as const,
      license: 'MIT',
      supportedLocales: [],
      limitations: [],
      notes: '',
      admissionRecord: 'test',
      verifiedAt: '2026-01-01T00:00:00Z',
    }),
    listInstalledVoices: async () => [{ nativeId: 'v', languageName: 'Test', file: 'v' }],
    getCapabilities: () => ({}) as never,
    synthesize: async () => {
      throw new Error('not used');
    },
    phonemes: async () => '',
    healthCheck: async () => ({
      ok: healthy,
      version: healthy ? '1.0' : null,
      detail: healthy ? 'ok' : 'down',
    }),
  };
}

describe('EngineRegistry', () => {
  it('registers, resolves and lists engines', () => {
    const r = new EngineRegistry().register(fake('a')).register(fake('b'));
    expect(r.ids()).toEqual(['a', 'b']);
    expect(r.get('b').engineId).toBe('b');
    expect(r.has('c')).toBe(false);
  });
  it('rejects duplicate ids', () => {
    expect(() => new EngineRegistry().register(fake('a')).register(fake('a'))).toThrow(/already registered/);
  });
  it('never falls back to another engine for an unknown id', () => {
    const r = new EngineRegistry().register(fake('a'));
    try {
      r.get('missing');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as VoxError).code).toBe(ErrorCodes.ENGINE_UNAVAILABLE);
    }
  });
  it('reports health per engine without hiding failures', async () => {
    const r = new EngineRegistry().register(fake('a')).register(fake('b', false));
    const h = await r.healthAll();
    expect(h.a!.ok).toBe(true);
    expect(h.b).toMatchObject({ ok: false, detail: 'down' });
  });
});

describe('catalog with several engines', () => {
  const allow: AllowlistEntry[] = [
    { id: 'a:v', engineId: 'a', nativeId: 'v', locale: 'vi-VN', displayName: 'A voice', accent: null },
    { id: 'b:v', engineId: 'b', nativeId: 'v', locale: 'vi-VN', displayName: 'B voice', accent: null },
  ];
  const installed = [{ nativeId: 'v', languageName: 'Test', file: 'v' }];
  const report = (engineId: string): QaReport => ({
    engineId,
    engineVersion: '1.0',
    corpusVersion: 'c',
    generatedAt: '',
    results: {
      'a:v': { status: 'passed', checks: [], sampleText: '' },
      'b:v': { status: 'passed', checks: [], sampleText: '' },
    },
  });
  it('builds only the voices of the given engine, with that engine’s license', () => {
    const c = buildCatalog(allow, installed, report('a'), { id: 'a', version: '1.0', license: 'MIT' });
    expect(c.map((v) => v.id)).toEqual(['a:v']);
    expect(c[0]!.license).toBe('MIT');
  });
  it('does not accept another engine’s QA report', () => {
    const c = buildCatalog(allow, installed, report('b'), { id: 'a', version: '1.0', license: 'MIT' });
    expect(c.filter(isSelectable)).toEqual([]);
    expect(c[0]!.qaNotes).toMatch(/does not match/);
  });
});
