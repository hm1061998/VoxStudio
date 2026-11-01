import {
  ErrorCodes,
  LIMITS,
  SETTING_KEYS,
  VoxError,
  type NumericParameterCapability,
  type PartialSettings,
  type SynthesisSettings,
  type VoiceCapabilities,
} from '@voxstudio/contracts';

/** eSpeak NG voice variants exposed to users (rule-based formant parameter files in `voices/!v`). */
export const ESPEAK_VARIANTS: { value: string; label: string }[] = [
  { value: 'default', label: 'Default (language voice)' },
  { value: 'm2', label: 'Male 2' },
  { value: 'm3', label: 'Male 3' },
  { value: 'm4', label: 'Male 4' },
  { value: 'f1', label: 'Female 1' },
  { value: 'f2', label: 'Female 2' },
  { value: 'f3', label: 'Female 3' },
  { value: 'f4', label: 'Female 4' },
  { value: 'klatt', label: 'Klatt formant 1' },
  { value: 'klatt2', label: 'Klatt formant 2' },
  { value: 'klatt3', label: 'Klatt formant 3' },
];

const num = (c: Omit<NumericParameterCapability, 'kind'>): NumericParameterCapability => ({
  kind: 'number',
  ...c,
});

/**
 * Capability metadata for eSpeak NG voices. `native` parameters map to engine flags;
 * `dsp` parameters are post-processing (FFmpeg / Rubber Band / VoxStudio gain stage).
 */
export function espeakCapabilities(availableVariants: string[]): VoiceCapabilities {
  return {
    variant: {
      kind: 'enum',
      support: 'native',
      group: 'voice',
      label: 'Voice variant',
      default: 'default',
      options: ESPEAK_VARIANTS.filter((v) => v.value === 'default' || availableVariants.includes(v.value)),
      description: 'eSpeak NG variant file (formant parameter set). Engine-native.',
    },
    rate: num({
      support: 'native',
      group: 'timing',
      label: 'Speaking rate',
      min: 0.5,
      max: 2,
      default: 1,
      step: 0.05,
      unit: '×',
      description:
        'Engine-native rate (eSpeak -s, 1× = 175 words per minute). Changes pacing without DSP artifacts.',
    }),
    pitch: num({
      support: 'native',
      group: 'voice',
      label: 'Base pitch',
      min: 0,
      max: 99,
      default: 50,
      step: 1,
      unit: 'eSpeak units',
      description: 'Engine-native base pitch (eSpeak -p, 0–99).',
    }),
    pitchRange: num({
      support: 'native',
      group: 'emphasis',
      label: 'Intonation range',
      min: 0,
      max: 99,
      default: 50,
      step: 1,
      unit: 'eSpeak units',
      description:
        'Engine-native pitch range (eSpeak -P). 0 = monotone, higher = wider rule-based intonation contour.',
    }),
    wordGapMs: num({
      support: 'native',
      group: 'timing',
      label: 'Gap between words',
      min: 0,
      max: 500,
      default: 0,
      step: 10,
      unit: 'ms',
      description: 'Engine-native extra pause between words (eSpeak -g, 10 ms units at default rate).',
    }),
    volumeDb: num({
      support: 'dsp',
      group: 'dsp',
      label: 'Volume (DSP gain)',
      min: -24,
      max: 12,
      default: 0,
      step: 0.5,
      unit: 'dB',
      description:
        'Post-synthesis gain. If the result would clip, VoxStudio attenuates it to −1 dBFS and reports a warning.',
    }),
    tempo: num({
      support: 'dsp',
      group: 'dsp',
      label: 'Time stretch (DSP)',
      min: 0.5,
      max: 2,
      default: 1,
      step: 0.01,
      unit: '×',
      recommendedMin: 0.8,
      recommendedMax: 1.25,
      description:
        'FFmpeg atempo time-stretch, pitch preserved. Prefer "Speaking rate"; artifacts are likely outside 0.8–1.25×.',
    }),
    pitchShiftSemitones: num({
      support: 'dsp',
      group: 'dsp',
      label: 'Pitch shift (DSP)',
      min: -12,
      max: 12,
      default: 0,
      step: 0.5,
      unit: 'semitones',
      recommendedMin: -4,
      recommendedMax: 4,
      description:
        'Rubber Band pitch shift independent of duration. Large shifts introduce audible artifacts.',
    }),
    highpassHz: num({
      support: 'dsp',
      group: 'eq',
      label: 'High-pass filter',
      min: 0,
      max: 400,
      default: 0,
      step: 10,
      unit: 'Hz',
      description: 'Removes rumble below the cutoff. 0 = off.',
    }),
    lowShelfDb: num({
      support: 'dsp',
      group: 'eq',
      label: 'Low shelf (150 Hz)',
      min: -12,
      max: 12,
      default: 0,
      step: 0.5,
      unit: 'dB',
      description: 'Shelving EQ below 150 Hz.',
    }),
    presenceDb: num({
      support: 'dsp',
      group: 'eq',
      label: 'Presence (3 kHz)',
      min: -12,
      max: 12,
      default: 0,
      step: 0.5,
      unit: 'dB',
      description: 'Peaking EQ at 3 kHz, Q 1.0.',
    }),
    highShelfDb: num({
      support: 'dsp',
      group: 'eq',
      label: 'High shelf (8 kHz)',
      min: -12,
      max: 12,
      default: 0,
      step: 0.5,
      unit: 'dB',
      description: 'Shelving EQ above 8 kHz.',
    }),
    compressor: {
      kind: 'boolean',
      support: 'dsp',
      group: 'dsp',
      label: 'Gentle compressor',
      default: false,
      description:
        'FFmpeg acompressor: threshold −18 dB, ratio 2:1, attack 20 ms, release 250 ms, makeup 0 dB.',
    },
    pauseBeforeMs: num({
      support: 'dsp',
      group: 'timing',
      label: 'Pause before',
      min: 0,
      max: LIMITS.pauseMaxMs,
      default: 0,
      step: 50,
      unit: 'ms',
      description: 'Exact silence inserted before this segment during assembly.',
    }),
    pauseAfterMs: num({
      support: 'dsp',
      group: 'timing',
      label: 'Pause after',
      min: 0,
      max: LIMITS.pauseMaxMs,
      default: 300,
      step: 50,
      unit: 'ms',
      description: 'Exact silence inserted after this segment during assembly.',
    }),
  };
}

export function defaultSettings(caps: VoiceCapabilities): SynthesisSettings {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) out[key] = caps[key].default;
  return out as SynthesisSettings;
}

/**
 * Server-authoritative validation of a full settings object against a voice's capabilities.
 * Rejects unsupported parameters set to non-default values and out-of-range numbers.
 */
export function validateSettingsForVoice(settings: SynthesisSettings, caps: VoiceCapabilities): void {
  for (const key of SETTING_KEYS) {
    const cap = caps[key];
    const value = settings[key];
    if (cap.support === 'unsupported') {
      if (value !== cap.default)
        throw new VoxError(
          ErrorCodes.PARAMETER_UNSUPPORTED,
          `"${cap.label}" is not supported by this voice.`,
          { parameter: key },
        );
      continue;
    }
    if (cap.kind === 'number') {
      if (typeof value !== 'number' || value < cap.min || value > cap.max)
        throw new VoxError(
          ErrorCodes.PARAMETER_OUT_OF_RANGE,
          `"${cap.label}" must be between ${cap.min} and ${cap.max} ${cap.unit}.`,
          {
            parameter: key,
            min: cap.min,
            max: cap.max,
          },
        );
    } else if (cap.kind === 'enum') {
      if (!cap.options.some((o) => o.value === value))
        throw new VoxError(
          ErrorCodes.PARAMETER_UNSUPPORTED,
          `"${String(value)}" is not an available ${cap.label.toLowerCase()}.`,
          { parameter: key },
        );
    } else if (typeof value !== 'boolean') {
      throw new VoxError(ErrorCodes.PARAMETER_OUT_OF_RANGE, `"${cap.label}" must be on or off.`, {
        parameter: key,
      });
    }
  }
}

export interface PresetChange {
  key: keyof SynthesisSettings;
  from: unknown;
  to: unknown;
}

/**
 * A style written for engine controls (rate, base pitch) means nothing to a voice that has none, such as the AI
 * voices. For those, speed becomes the time-stretch and pitch (0–100, 50 = neutral) becomes a pitch shift of
 * 1 semitone per 5 points, unless the style sets the audio-processing value itself. Range and word gap have no
 * equivalent and stay skipped.
 */
export function presetForVoice(preset: PartialSettings, caps: VoiceCapabilities): PartialSettings {
  const out: PartialSettings = { ...preset };
  if (
    caps.rate.support === 'unsupported' &&
    caps.tempo.support !== 'unsupported' &&
    preset.rate !== undefined
  ) {
    if (preset.tempo === undefined) out.tempo = preset.rate;
    delete out.rate;
  }
  if (
    caps.pitch.support === 'unsupported' &&
    caps.pitchShiftSemitones.support !== 'unsupported' &&
    preset.pitch !== undefined
  ) {
    if (preset.pitchShiftSemitones === undefined)
      out.pitchShiftSemitones = Math.round(((preset.pitch - 50) / 5) * 2) / 2;
    delete out.pitch;
  }
  return out;
}

/**
 * Apply a preset (partial settings) to settings. Returns the result plus the list of values that
 * change, so the UI can show it before applying. Parameters the voice cannot honour are reported, not applied.
 */
export function applyPreset(
  settings: SynthesisSettings,
  presetIn: PartialSettings,
  caps: VoiceCapabilities,
): { settings: SynthesisSettings; changes: PresetChange[]; skipped: (keyof SynthesisSettings)[] } {
  const preset = presetForVoice(presetIn, caps);
  const next: SynthesisSettings = { ...settings };
  const changes: PresetChange[] = [];
  const skipped: (keyof SynthesisSettings)[] = [];
  for (const key of SETTING_KEYS) {
    if (!(key in preset)) continue;
    const to = preset[key];
    const cap = caps[key];
    if (to === undefined) continue;
    if (cap.support === 'unsupported') {
      skipped.push(key);
      continue;
    }
    if (cap.kind === 'enum' && !cap.options.some((o) => o.value === to)) {
      skipped.push(key);
      continue;
    }
    if (cap.kind === 'number' && (typeof to !== 'number' || to < cap.min || to > cap.max)) {
      skipped.push(key);
      continue;
    }
    if (settings[key] !== to) changes.push({ key, from: settings[key], to });
    (next as Record<string, unknown>)[key] = to;
  }
  return { settings: next, changes, skipped };
}
