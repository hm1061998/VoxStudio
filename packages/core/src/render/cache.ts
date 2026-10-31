import { createHash } from 'node:crypto';
import { normalizeOutputProfile, type OutputProfile, type SynthesisSettings } from '@voxstudio/contracts';
import { DSP_CHAIN_VERSION, CANONICAL_SAMPLE_RATE } from '../audio/dsp';
import { ASSEMBLY_VERSION } from './assembly';
import { ENCODER_VERSION } from './encode';
import { NORMALIZATION_VERSION } from '../text/normalize';
import type { EngineChunk } from '../text/prepare';

export const CACHE_SCHEMA_VERSION = 'ck-1';

/** JSON with sorted keys at every level, so equal values always serialize identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Settings that change the segment's own audio. Pause before/after only affect assembly. */
export function synthesisAffectingSettings(
  s: SynthesisSettings,
): Omit<SynthesisSettings, 'pauseBeforeMs' | 'pauseAfterMs'> {
  const { pauseBeforeMs: _b, pauseAfterMs: _a, ...rest } = s;
  return rest;
}

export interface SegmentCacheInput {
  engineId: string;
  engineVersion: string;
  voiceId: string;
  voicePackageVersion: string;
  locale: string;
  /** Engine-ready chunks (already include normalization + pronunciation effects). */
  chunks: EngineChunk[];
  settings: SynthesisSettings;
  /** FFmpeg version string; only relevant when an FFmpeg stage runs, but always included for safety. */
  dspToolVersion: string;
}

export function segmentCacheKey(i: SegmentCacheInput): string {
  return sha256(
    stableStringify({
      v: CACHE_SCHEMA_VERSION,
      engine: [i.engineId, i.engineVersion],
      voice: [i.voiceId, i.voicePackageVersion],
      locale: i.locale,
      chunks: i.chunks,
      settings: synthesisAffectingSettings(i.settings),
      normalization: NORMALIZATION_VERSION,
      dsp: [DSP_CHAIN_VERSION, i.dspToolVersion],
      canonical: [CANONICAL_SAMPLE_RATE, 1, 's16'],
    }),
  );
}

export function projectCacheKey(i: {
  segments: { cacheKey: string; pauseBeforeMs: number; pauseAfterMs: number }[];
  joinFadeMs: number;
  outputProfile: OutputProfile;
  encoderToolVersion: string;
}): string {
  return sha256(
    stableStringify({
      v: CACHE_SCHEMA_VERSION,
      segments: i.segments,
      joinFadeMs: i.joinFadeMs,
      output: normalizeOutputProfile(i.outputProfile),
      versions: [ASSEMBLY_VERSION, ENCODER_VERSION, i.encoderToolVersion],
    }),
  );
}
