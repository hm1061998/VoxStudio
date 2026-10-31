import { readFile } from 'node:fs/promises';
import { ErrorCodes, VoxError, type SynthesisSettings, type VoiceCapabilities } from '@voxstudio/contracts';
import type { TtsEngineAdapter } from '../engine/types';
import type { EngineChunk } from '../text/prepare';
import {
  CANONICAL_SAMPLE_RATE,
  DSP_CHAIN_VERSION,
  applyFfmpegChain,
  applyGainWithHeadroom,
  buildFilterChain,
  concatFloat,
  settingsWarnings,
  silence,
} from '../audio/dsp';
import { decodeWavToFloat, encodeWavPcm16, rms } from '../audio/wav';

export interface SegmentSynthesisRequest {
  chunks: EngineChunk[];
  nativeVoiceId: string;
  settings: SynthesisSettings;
  capabilities: VoiceCapabilities;
  adapter: TtsEngineAdapter;
  ffmpeg: string;
  ffmpegVersion: string;
  tempDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Job priority forwarded to engines that queue requests (see plans). */
  priority?: number;
}

export interface SegmentSynthesisResult {
  /** Canonical PCM s16 mono WAV at CANONICAL_SAMPLE_RATE. */
  wav: Buffer;
  durationMs: number;
  engineSnapshot: Record<string, unknown>;
  dspSnapshot: Record<string, unknown>;
  warnings: string[];
}

/**
 * Synthesize one segment: engine per speech chunk → DSP chain per chunk → exact inline pauses →
 * gain + headroom → canonical s16 WAV. Output is validated before it is returned.
 */
export async function synthesizeSegment(req: SegmentSynthesisRequest): Promise<SegmentSynthesisResult> {
  const speech = req.chunks.filter((c) => c.kind === 'speech');
  if (!speech.length) throw new VoxError(ErrorCodes.EMPTY_TEXT, 'This segment has no speakable text.');
  const chain = buildFilterChain(req.settings);
  const parts: Float32Array[] = [];
  const engineRuns: Record<string, unknown>[] = [];
  for (const chunk of req.chunks) {
    if (req.signal?.aborted) throw new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.');
    if (chunk.kind === 'pause') {
      parts.push(silence(chunk.pauseMs));
      continue;
    }
    const out = await req.adapter.synthesize(
      { text: chunk.text, nativeVoiceId: req.nativeVoiceId, settings: req.settings },
      { tempDir: req.tempDir, timeoutMs: req.timeoutMs, signal: req.signal, priority: req.priority },
    );
    if (out.sampleRate !== CANONICAL_SAMPLE_RATE)
      throw new VoxError(
        ErrorCodes.OUTPUT_VALIDATION_FAILED,
        'Engine sample rate differs from the canonical format.',
      );
    engineRuns.push({ ...out.engine, durationMs: out.durationMs });
    const samples = chain
      ? await applyFfmpegChain(req.ffmpeg, out.filePath, chain, {
          tempDir: req.tempDir,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
        })
      : decodeWavToFloat(await readFile(out.filePath)).samples;
    parts.push(samples);
  }
  const joined = concatFloat(parts);
  const gain = applyGainWithHeadroom(joined, req.settings.volumeDb);
  if (rms(gain.samples) < 1e-4)
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Synthesized audio is silent.');
  const { wav, clippedSamples } = encodeWavPcm16(gain.samples, CANONICAL_SAMPLE_RATE, 1);
  if (clippedSamples > 0)
    throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Clipping detected after headroom protection.');
  const warnings = settingsWarnings(req.settings, req.capabilities);
  if (gain.attenuationDb > 0)
    warnings.push(
      `Output was attenuated by ${gain.attenuationDb.toFixed(1)} dB to prevent clipping (requested gain ${req.settings.volumeDb} dB).`,
    );
  return {
    wav,
    durationMs: Math.round((gain.samples.length / CANONICAL_SAMPLE_RATE) * 1000),
    engineSnapshot: { engineId: req.adapter.engineId, runs: engineRuns },
    dspSnapshot: {
      chainVersion: DSP_CHAIN_VERSION,
      ffmpegVersion: chain ? req.ffmpegVersion : null,
      filters: chain ?? [],
      gainDb: req.settings.volumeDb,
      headroomAttenuationDb: Number(gain.attenuationDb.toFixed(3)),
      peakDbfsBeforeHeadroom: Number.isFinite(gain.peakDbfsBefore)
        ? Number(gain.peakDbfsBefore.toFixed(3))
        : null,
      sampleRate: CANONICAL_SAMPLE_RATE,
      channels: 1,
      sampleFormat: 's16',
    },
    warnings,
  };
}
