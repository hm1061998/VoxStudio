import { describe, expect, it } from 'vitest';
import {
  SETTING_KEYS,
  type ParameterCapability,
  type ParameterSupport,
  type SettingKey,
  type SynthesisSettings,
  type VoiceCapabilities,
} from '@voxstudio/contracts';
import { reconcileSettings } from './reconcile';

const num = (support: ParameterSupport, min: number, max: number, def: number): ParameterCapability => ({
  kind: 'number',
  support,
  group: 'voice',
  label: 'x',
  min,
  max,
  default: def,
  step: 1,
  unit: '',
  description: '',
});

function caps(over: Partial<Record<SettingKey, ParameterCapability>> = {}): VoiceCapabilities {
  const base = Object.fromEntries(SETTING_KEYS.map((k) => [k, num('native', 0, 100, 50)])) as Record<
    SettingKey,
    ParameterCapability
  >;
  base.variant = {
    kind: 'enum',
    support: 'native',
    group: 'voice',
    label: 'v',
    default: 'default',
    options: [{ value: 'default', label: 'Default' }],
    description: '',
  };
  base.compressor = {
    kind: 'boolean',
    support: 'dsp',
    group: 'dsp',
    label: 'c',
    default: false,
    description: '',
  };
  return { ...base, ...over } as VoiceCapabilities;
}

const settings = (over: Partial<SynthesisSettings> = {}): SynthesisSettings =>
  ({
    ...Object.fromEntries(SETTING_KEYS.map((k) => [k, 50])),
    variant: 'default',
    compressor: false,
    ...over,
  }) as unknown as SynthesisSettings;

describe('reconcileSettings (engine switch)', () => {
  it('leaves settings untouched when the new voice supports them all', () => {
    const s = settings({ rate: 70 });
    const r = reconcileSettings(s, caps());
    expect(r.changes).toEqual([]);
    expect(r.settings).toEqual(s);
  });

  it('resets values for controls the new engine does not support and reports them', () => {
    const r = reconcileSettings(
      settings({ wordGapMs: 80, variant: 'f2' }),
      caps({
        wordGapMs: num('unsupported', 0, 0, 0),
        variant: {
          kind: 'enum',
          support: 'unsupported',
          group: 'voice',
          label: 'v',
          default: 'default',
          options: [{ value: 'default', label: 'Default' }],
          description: '',
        },
      }),
    );
    expect(r.settings.wordGapMs).toBe(0);
    expect(r.settings.variant).toBe('default');
    expect(r.changes.map((c) => [c.key, c.reason])).toEqual(
      expect.arrayContaining([
        ['wordGapMs', 'unsupported'],
        ['variant', 'unsupported'],
      ]),
    );
  });

  it('clamps out-of-range numbers and replaces unknown enum options', () => {
    const r = reconcileSettings(
      settings({ rate: 300, variant: 'm3' }),
      caps({ rate: num('native', 50, 200, 100) }),
    );
    expect(r.settings.rate).toBe(200);
    expect(r.settings.variant).toBe('default');
    expect(r.changes.find((c) => c.key === 'rate')?.reason).toBe('out-of-range');
    expect(r.changes.find((c) => c.key === 'variant')?.reason).toBe('invalid-option');
  });

  it('does not mutate its input and is idempotent', () => {
    const s = settings({ rate: 300 });
    const c = caps({ rate: num('native', 50, 200, 100) });
    const once = reconcileSettings(s, c);
    expect(s.rate).toBe(300);
    expect(reconcileSettings(once.settings, c).changes).toEqual([]);
  });
});
