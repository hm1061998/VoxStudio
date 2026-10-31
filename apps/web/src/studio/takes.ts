import { SETTING_KEYS, type SettingKey, type SynthesisSettings } from '@voxstudio/contracts';

export interface SettingDifference {
  key: SettingKey;
  from: unknown;
  to: unknown;
}

/** Settings that differ between two settings objects (key order of SETTING_KEYS, deterministic). */
export function diffSettings(a: SynthesisSettings, b: SynthesisSettings): SettingDifference[] {
  return SETTING_KEYS.filter((k) => a[k] !== b[k]).map((key) => ({ key, from: a[key], to: b[key] }));
}

export interface TakeLike {
  voiceId: string;
  text: string;
  settings: SynthesisSettings;
}

export interface TakeDifference {
  voice: { from: string; to: string } | null;
  textChanged: boolean;
  settings: SettingDifference[];
}

/** What differs between two takes: voice, text and each setting. Used by the compare view. */
export function diffTakes(a: TakeLike, b: TakeLike): TakeDifference {
  return {
    voice: a.voiceId === b.voiceId ? null : { from: a.voiceId, to: b.voiceId },
    textChanged: a.text !== b.text,
    settings: diffSettings(a.settings, b.settings),
  };
}

export const isIdentical = (d: TakeDifference): boolean =>
  !d.voice && !d.textChanged && d.settings.length === 0;
