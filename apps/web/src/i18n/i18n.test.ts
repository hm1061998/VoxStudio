import { describe, expect, it } from 'vitest';
import { en } from './en';
import { vi } from './vi';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('UI translations', () => {
  it('Vietnamese defines exactly the English keys', () => {
    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
  });
  it('placeholders match in every message', () => {
    for (const [key, text] of Object.entries(en))
      expect(placeholders(vi[key as keyof typeof vi]), key).toEqual(placeholders(text));
  });
  it('no Vietnamese message is empty or left in English by accident', () => {
    // Product names with placeholders are legitimately identical.
    const same = Object.entries(en).filter(
      ([k, v]) => v.length > 25 && k !== 'insp.engineInfo' && vi[k as keyof typeof vi] === v,
    );
    expect(same.map(([k]) => k)).toEqual([]);
    for (const [k, v] of Object.entries(vi))
      if (!k.startsWith('unit.')) expect(v.length, k).toBeGreaterThan(0);
  });
  it('every server error code has a translation', async () => {
    const { ErrorCodes } = await import('@voxstudio/contracts');
    for (const code of Object.values(ErrorCodes)) expect(`error.${code}` in en, code).toBe(true);
  });
  it('every setting has a label and description', async () => {
    const { SETTING_KEYS } = await import('@voxstudio/contracts');
    for (const k of SETTING_KEYS) {
      expect(`setting.${k}.label` in en, k).toBe(true);
      expect(`setting.${k}.desc` in en, k).toBe(true);
    }
  });
});
