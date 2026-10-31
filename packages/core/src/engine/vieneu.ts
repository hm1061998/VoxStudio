import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ErrorCodes,
  VoxError,
  type PhoneticInventoryDto,
  type SettingKey,
  type VoiceCapabilities,
} from '@voxstudio/contracts';
import { CANONICAL_SAMPLE_RATE } from '../audio/dsp';
import { concatFloat, silence } from '../audio/dsp';
import { decodeWavToFloat, encodeWavPcm16 } from '../audio/wav';
import { espeakCapabilities } from './capabilities';
import type {
  EngineAudioOutput,
  EngineContext,
  EngineHealth,
  EngineMetadata,
  EngineVoiceProfile,
  InstalledVoice,
  SynthesisInput,
  TtsEngineAdapter,
} from './types';

export const VIENEU_ENGINE_ID = 'vieneu';

export interface VieneuAdapterOptions {
  /** Base URLs of the model service instances (internal network). */
  urls: string[];
  token: string;
  /** Max characters sent in one request (long text is split at sentence boundaries). */
  maxChunkChars?: number;
  /** Pause inserted between pieces of one chunk, in ms. */
  pieceGapMs?: number;
  /** The operator's admission decision (ADR 0008): only an approved engine can be enabled by an administrator. */
  approved?: boolean;
}

interface ServiceVoice {
  id: string;
  description: string;
  gender: 'female' | 'male' | null;
  region: 'northern' | 'central' | 'southern' | null;
}

/** ASCII slug used as the VoxStudio native voice id ("Ngọc Huyền" → "ngoc-huyen"). */
export function voiceSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Split text into pieces of at most `max` characters, preferring sentence ends, then commas, then spaces. */
export function splitForModel(text: string, max: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…;:\n]+[.!?…;:]*\s*/g) ?? [clean];
  const pieces: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) pieces.push(cur.trim());
    cur = '';
  };
  const hard = (s: string): string[] => {
    const out: string[] = [];
    let rest = s.trim();
    while (rest.length > max) {
      let cut = rest.lastIndexOf(',', max - 1);
      if (cut < max / 3) cut = rest.lastIndexOf(' ', max - 1);
      if (cut < max / 3) cut = max - 1;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  };
  for (const s of sentences) {
    if (s.length > max) {
      flush();
      pieces.push(...hard(s));
    } else if ((cur + s).length > max) {
      flush();
      cur = s;
    } else cur += s;
  }
  flush();
  return pieces;
}

const UNSUPPORTED_NATIVE: SettingKey[] = ['variant', 'rate', 'pitch', 'pitchRange', 'wordGapMs'];

/**
 * Engine adapter for the self-hosted neural model service (ADR 0008). **This engine uses AI.** It is optional,
 * registered only when a service URL is configured, ships `unverified` and never substitutes another engine.
 */
export class VieneuAdapter implements TtsEngineAdapter {
  readonly engineId = VIENEU_ENGINE_ID;
  readonly optional = true;
  private voices = new Map<string, ServiceVoice>();
  private modelVersion = '0';
  private rr = 0;

  constructor(private readonly opts: VieneuAdapterOptions) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-service-token': this.opts.token };
  }

  private pickUrls(): string[] {
    const n = this.opts.urls.length;
    const start = this.rr++ % n;
    return Array.from({ length: n }, (_, i) => this.opts.urls[(start + i) % n]!);
  }

  async initialize(): Promise<void> {
    for (const url of this.opts.urls) {
      try {
        const r = await fetch(`${url}/v1/voices`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) continue;
        const j = (await r.json()) as { model: string; voices: ServiceVoice[] };
        this.voices = new Map(j.voices.map((v) => [voiceSlug(v.id), v]));
        this.modelVersion = j.model.split(' ').pop() ?? '0';
        return;
      } catch {
        /* try the next instance */
      }
    }
    this.voices.clear();
  }

  async getMetadata(): Promise<EngineMetadata> {
    return {
      id: VIENEU_ENGINE_ID,
      name: 'VieNeu-TTS (AI, self-hosted)',
      version: this.modelVersion,
      synthesisMethod:
        'Neural text-to-speech (VieNeu-TTS v3 Turbo) running in a self-hosted model service; preset voices only. This engine uses AI.',
      complianceStatus: this.opts.approved ? 'approved' : 'unverified',
      usesAi: true,
      license: 'Apache-2.0 (code and weights, per the model card)',
      supportedLocales: ['vi-VN'],
      limitations: [
        'Uses an AI model: output is generated, can contain mispronunciations, and is not bit-reproducible between runs (the render cache keeps the first result).',
        'Preset voices only; no voice cloning. Rate, base pitch, pitch range and word gap are not engine controls: use the time-stretch and pitch-shift audio processing instead.',
        'Pronunciation dictionary entries must be written as plain Vietnamese respellings (no phoneme notation).',
        'Slower than the rule-based engines: roughly real time on a few CPU cores. Jobs wait in a queue where paid plans go first.',
      ],
      notes:
        'Opt-in AI engine (ADR 0008). Needs the operator admission flag (VIENEU_APPROVED=true) before an administrator can enable it.',
      admissionRecord: 'docs/decisions/0008-self-hosted-ai-engine-at-run-time.md',
      verifiedAt: '2026-10-31T00:00:00Z',
    };
  }

  async listInstalledVoices(): Promise<InstalledVoice[]> {
    return [...this.voices.entries()].map(([slug, v]) => ({
      nativeId: slug,
      languageName: 'Vietnamese',
      file: v.id,
    }));
  }

  private voice(nativeId: string): ServiceVoice {
    const v = this.voices.get(nativeId);
    if (!v)
      throw new VoxError(ErrorCodes.VOICE_NOT_AVAILABLE, 'The selected voice is not available.', {
        voiceId: nativeId,
      });
    return v;
  }

  getCapabilities(_nativeVoiceId: string): VoiceCapabilities {
    // Identical for every preset voice, and usable before the service has been reached.
    const caps = espeakCapabilities([]);
    for (const k of UNSUPPORTED_NATIVE)
      caps[k] = {
        ...caps[k],
        support: 'unsupported',
        description:
          'Not an engine control for this AI voice. Use "Time stretch" and "Pitch shift" (audio processing) to change speed and pitch.',
      } as VoiceCapabilities[SettingKey];
    return caps;
  }

  getVoiceProfile(nativeVoiceId: string): EngineVoiceProfile {
    const v = this.voice(nativeVoiceId);
    const inventory: PhoneticInventoryDto = {
      kind: 'neural',
      onsets: [],
      nuclei: [],
      codas: [],
      tones: [],
      recordedSyllables: null,
      note: 'Neural model: there is no enumerable inventory of sounds.',
    };
    return {
      region: v.region,
      gender: v.gender,
      voiceDatabaseVersion: `VieNeu-TTS v3 Turbo ${this.modelVersion} preset "${v.id}"`,
      inventory,
      dataset: null,
    };
  }

  async synthesize(input: SynthesisInput, ctx: EngineContext): Promise<EngineAudioOutput> {
    if (ctx.signal?.aborted) throw new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.');
    if (input.text.includes('[['))
      throw new VoxError(
        ErrorCodes.PRONUNCIATION_INVALID,
        'Phoneme notation is not supported by this engine; use a Vietnamese respelling.',
      );
    if (!this.voices.size) await this.initialize(); // the service may have started after this process
    const v = this.voice(input.nativeVoiceId);
    const pieces = splitForModel(input.text, this.opts.maxChunkChars ?? 600);
    if (!pieces.length) throw new VoxError(ErrorCodes.EMPTY_TEXT, 'There is no speakable text.');
    const parts: Float32Array[] = [];
    const t0 = Date.now();
    let waitMs = 0;
    for (let i = 0; i < pieces.length; i++) {
      const { samples, wait } = await this.request(pieces[i]!, v.id, ctx);
      waitMs += wait;
      if (i > 0) parts.push(silence(this.opts.pieceGapMs ?? 120));
      parts.push(samples);
    }
    const joined = concatFloat(parts);
    const { wav } = encodeWavPcm16(joined, CANONICAL_SAMPLE_RATE, 1);
    mkdirSync(ctx.tempDir, { recursive: true });
    const filePath = path.join(ctx.tempDir, `vieneu-${process.hrtime.bigint()}.wav`);
    writeFileSync(filePath, wav);
    return {
      filePath,
      codec: 'pcm_s16le',
      sampleRate: CANONICAL_SAMPLE_RATE,
      channels: 1,
      durationMs: Math.round((joined.length / CANONICAL_SAMPLE_RATE) * 1000),
      engine: {
        id: VIENEU_ENGINE_ID,
        version: this.modelVersion,
        nativeVoiceId: input.nativeVoiceId,
        // No user text here: only sizes and timings.
        args: [`pieces=${pieces.length}`, `queueWaitMs=${waitMs}`, `totalMs=${Date.now() - t0}`],
      },
    };
  }

  private async request(
    text: string,
    voiceName: string,
    ctx: EngineContext,
  ): Promise<{ samples: Float32Array; wait: number }> {
    let lastError: VoxError | null = null;
    for (const url of this.pickUrls()) {
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)])
        : AbortSignal.timeout(ctx.timeoutMs);
      let res: Response;
      try {
        res = await fetch(`${url}/v1/synthesize`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ text, voice: voiceName, priority: ctx.priority ?? 0 }),
          signal,
        });
      } catch (e) {
        if (ctx.signal?.aborted) throw new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.');
        if ((e as Error).name === 'TimeoutError')
          throw new VoxError(ErrorCodes.SYNTHESIS_TIMEOUT, 'The AI voice took too long to respond.');
        lastError = new VoxError(ErrorCodes.ENGINE_UNAVAILABLE, 'The AI voice service is not reachable.');
        continue; // another instance of the SAME engine may answer
      }
      if (res.status === 503) {
        lastError = new VoxError(ErrorCodes.ENGINE_BUSY, 'The AI voice service is busy. Try again shortly.');
        continue;
      }
      if (!res.ok)
        throw new VoxError(
          res.status === 413 || res.status === 400 ? ErrorCodes.TEXT_TOO_LONG : ErrorCodes.SYNTHESIS_FAILED,
          'The AI voice service could not synthesize this text.',
          { status: res.status },
        );
      const { samples, info } = decodeWavToFloat(Buffer.from(await res.arrayBuffer()));
      if (info.sampleRate !== CANONICAL_SAMPLE_RATE || info.channels !== 1)
        throw new VoxError(
          ErrorCodes.OUTPUT_VALIDATION_FAILED,
          'The AI voice service returned an unexpected format.',
        );
      return { samples, wait: Number(res.headers.get('x-queue-wait-ms') ?? 0) };
    }
    throw lastError ?? new VoxError(ErrorCodes.ENGINE_UNAVAILABLE, 'The AI voice service is not reachable.');
  }

  async phonemes(): Promise<string> {
    return ''; // a neural model has no deterministic phoneme output to show
  }

  async healthCheck(): Promise<EngineHealth> {
    for (const url of this.opts.urls) {
      try {
        const r = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(5_000) });
        const j = (await r.json()) as {
          ready: boolean;
          version: string;
          instances: number;
          busy: number;
          queued: number;
        };
        if (r.ok && j.ready) {
          if (!this.voices.size) await this.initialize();
          return {
            ok: true,
            version: this.modelVersion,
            detail: `${j.version}; ${j.busy}/${j.instances} busy, ${j.queued} queued`,
          };
        }
      } catch {
        /* next */
      }
    }
    return { ok: false, version: null, detail: 'AI voice service is not reachable or still loading.' };
  }
}
