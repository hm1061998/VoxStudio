import { describe, expect, it } from 'vitest';
import { SETTING_KEYS, type SynthesisSettings } from '@voxstudio/contracts';
import { diffSettings, diffTakes, isIdentical } from './takes';

const base = Object.fromEntries(SETTING_KEYS.map((k) => [k, 1])) as unknown as SynthesisSettings;

describe('take comparison', () => {
  it('lists only the settings that differ, in canonical order', () => {
    const b = { ...base, pitch: 60, rate: 2 } as SynthesisSettings;
    expect(diffSettings(base, b)).toEqual([
      { key: 'rate', from: 1, to: 2 },
      { key: 'pitch', from: 1, to: 60 },
    ]);
    expect(diffSettings(base, { ...base })).toEqual([]);
  });

  it('reports voice, text and settings differences between takes', () => {
    const a = { voiceId: 'espeak:vi', text: 'Xin chào', settings: base };
    const b = { voiceId: 'espeak:vi-vn-x-south', text: 'Xin chào', settings: { ...base, rate: 2 } };
    const d = diffTakes(a, b);
    expect(d.voice).toEqual({ from: 'espeak:vi', to: 'espeak:vi-vn-x-south' });
    expect(d.textChanged).toBe(false);
    expect(d.settings.map((x) => x.key)).toEqual(['rate']);
    expect(isIdentical(d)).toBe(false);
    expect(isIdentical(diffTakes(a, { ...a }))).toBe(true);
    expect(diffTakes(a, { ...a, text: 'Chào' }).textChanged).toBe(true);
  });
});
