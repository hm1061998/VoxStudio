import { z } from 'zod';

/**
 * Canonical synthesis + DSP settings for one segment (schema version 1).
 * Which parameters are engine-native vs DSP vs unsupported is declared per voice by
 * `VoiceCapabilities`; the server is authoritative.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

export type ParameterSupport = 'native' | 'dsp' | 'unsupported';
export type ParameterGroup = 'voice' | 'timing' | 'emphasis' | 'dsp' | 'eq';

export interface NumericParameterCapability {
  kind: 'number';
  support: ParameterSupport;
  group: ParameterGroup;
  label: string;
  min: number;
  max: number;
  default: number;
  step: number;
  unit: string;
  description: string;
  /** Values outside this range are allowed but may produce audible artifacts. */
  recommendedMin?: number;
  recommendedMax?: number;
}

export interface BooleanParameterCapability {
  kind: 'boolean';
  support: ParameterSupport;
  group: ParameterGroup;
  label: string;
  default: boolean;
  description: string;
}

export interface EnumParameterCapability {
  kind: 'enum';
  support: ParameterSupport;
  group: ParameterGroup;
  label: string;
  default: string;
  options: { value: string; label: string }[];
  description: string;
}

export type ParameterCapability =
  NumericParameterCapability | BooleanParameterCapability | EnumParameterCapability;

export const SETTING_KEYS = [
  'variant',
  'rate',
  'pitch',
  'pitchRange',
  'wordGapMs',
  'volumeDb',
  'tempo',
  'pitchShiftSemitones',
  'highpassHz',
  'lowShelfDb',
  'presenceDb',
  'highShelfDb',
  'compressor',
  'pauseBeforeMs',
  'pauseAfterMs',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export type VoiceCapabilities = Record<SettingKey, ParameterCapability>;

/**
 * Structural schema: types and absolute bounds. Per-voice range/support checks happen in
 * `validateSettingsForVoice` (core) because they depend on capability metadata.
 */
export const synthesisSettingsSchema = z.strictObject({
  variant: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  rate: z.number().finite(),
  pitch: z.number().finite(),
  pitchRange: z.number().finite(),
  wordGapMs: z.number().finite(),
  volumeDb: z.number().finite(),
  tempo: z.number().finite(),
  pitchShiftSemitones: z.number().finite(),
  highpassHz: z.number().finite(),
  lowShelfDb: z.number().finite(),
  presenceDb: z.number().finite(),
  highShelfDb: z.number().finite(),
  compressor: z.boolean(),
  pauseBeforeMs: z.number().int(),
  pauseAfterMs: z.number().int(),
});
export type SynthesisSettings = z.infer<typeof synthesisSettingsSchema>;

/** Partial settings, e.g. a preset or a PATCH body. Unknown keys are rejected. */
export const partialSettingsSchema = synthesisSettingsSchema.partial();
export type PartialSettings = z.infer<typeof partialSettingsSchema>;

export const OUTPUT_FORMATS = ['wav', 'mp3', 'ogg'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export const OUTPUT_SAMPLE_RATES = [22050, 44100, 48000] as const;

export const outputProfileSchema = z
  .strictObject({
    format: z.enum(OUTPUT_FORMATS),
    sampleRate: z.union([z.literal(22050), z.literal(44100), z.literal(48000)]),
    channels: z.union([z.literal(1), z.literal(2)]),
    bitDepth: z.union([z.literal(16), z.literal(24)]).optional(),
    bitrateKbps: z.number().int().min(64).max(320).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.format === 'wav' && p.bitrateKbps !== undefined)
      ctx.addIssue({ code: 'custom', message: 'bitrateKbps does not apply to WAV', path: ['bitrateKbps'] });
    if (p.format !== 'wav' && p.bitDepth !== undefined)
      ctx.addIssue({ code: 'custom', message: 'bitDepth applies only to WAV', path: ['bitDepth'] });
  });
export type OutputProfile = z.infer<typeof outputProfileSchema>;

export const DEFAULT_OUTPUT_PROFILE: OutputProfile = {
  format: 'wav',
  sampleRate: 22050,
  channels: 1,
  bitDepth: 16,
};

/** Large uncompressed output (48 kHz, stereo or 24-bit WAV): up to 4.4 times the default size. Plans may exclude it. */
export function isHeavyOutputProfile(p: OutputProfile): boolean {
  return p.format === 'wav' && (p.sampleRate > 22050 || p.channels > 1 || (p.bitDepth ?? 16) > 16);
}

/** Fill format-specific defaults so equivalent profiles produce identical cache keys. */
export function normalizeOutputProfile(
  p: OutputProfile,
): Required<Pick<OutputProfile, 'format' | 'sampleRate' | 'channels'>> &
  Pick<OutputProfile, 'bitDepth' | 'bitrateKbps'> {
  if (p.format === 'wav')
    return { format: 'wav', sampleRate: p.sampleRate, channels: p.channels, bitDepth: p.bitDepth ?? 16 };
  return {
    format: p.format,
    sampleRate: p.sampleRate,
    channels: p.channels,
    bitrateKbps: p.bitrateKbps ?? 128,
  };
}

/** Rough size estimate for the export dialog; labelled as an estimate in the UI. */
export function estimateOutputBytes(p: OutputProfile, durationMs: number): number {
  const n = normalizeOutputProfile(p);
  const seconds = durationMs / 1000;
  if (n.format === 'wav')
    return Math.round(44 + seconds * n.sampleRate * n.channels * ((n.bitDepth ?? 16) / 8));
  return Math.round((seconds * (n.bitrateKbps ?? 128) * 1000) / 8);
}

/** Key-order-independent equality (JSONB storage does not preserve key order). */
export function settingsEqual(
  a: Partial<SynthesisSettings> | null | undefined,
  b: Partial<SynthesisSettings> | null | undefined,
): boolean {
  if (!a || !b) return a === b;
  return SETTING_KEYS.every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
}
