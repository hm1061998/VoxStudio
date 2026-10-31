import { describe, expect, it } from 'vitest';
import {
  SETTING_KEYS,
  type ParameterSupport,
  type SettingKey,
  type VoiceCapabilities,
} from '@voxstudio/contracts';
import { simpleKeysFor } from './Inspector';

const caps = (support: Partial<Record<SettingKey, ParameterSupport>>): VoiceCapabilities =>
  Object.fromEntries(
    SETTING_KEYS.map((k) => [k, { kind: 'number', support: support[k] ?? 'native' }]),
  ) as unknown as VoiceCapabilities;

describe('simple mode controls', () => {
  it('shows speed and pitch as usual when the engine has them', () => {
    expect(simpleKeysFor(caps({}))).toEqual(['variant', 'rate', 'pitch', 'volumeDb', 'pauseAfterMs']);
    expect(simpleKeysFor(undefined)).toContain('rate');
  });

  it('offers the audio-processing equivalents when an AI voice has no engine-native speed or pitch', () => {
    const ai = caps({ rate: 'unsupported', pitch: 'unsupported', tempo: 'dsp', pitchShiftSemitones: 'dsp' });
    expect(simpleKeysFor(ai)).toEqual([
      'variant',
      'tempo',
      'pitchShiftSemitones',
      'volumeDb',
      'pauseAfterMs',
    ]);
  });

  it('never substitutes a control that is itself unsupported', () => {
    const none = caps({ rate: 'unsupported', tempo: 'unsupported' });
    expect(simpleKeysFor(none)).toContain('rate');
  });
});
