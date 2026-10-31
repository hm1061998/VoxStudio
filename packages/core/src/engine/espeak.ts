import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ErrorCodes, VoxError, type VoiceCapabilities } from '@voxstudio/contracts';
import { runProcess, redactToolOutput } from '../process';
import { parseWavHeader } from '../audio/wav';
import { ESPEAK_VARIANTS, espeakCapabilities } from './capabilities';
import type {
  EngineAudioOutput,
  EngineContext,
  EngineHealth,
  EngineMetadata,
  InstalledVoice,
  SynthesisInput,
  TtsEngineAdapter,
} from './types';

export const ESPEAK_ENGINE_ID = 'espeak';
export const ESPEAK_LIMITATIONS = [
  'Formant synthesis: intelligible but clearly synthetic; not a human performance.',
  'Intonation follows eSpeak NG rules; emphasis can be shaped only through pitch range, rate, word gap and pauses.',
  'DSP time-stretch and pitch-shift can introduce audible artifacts at extreme settings.',
  'No breath, emotion or speaking-style synthesis.',
];
export const ESPEAK_DEFAULT_WPM = 175;
/** eSpeak NG always renders mono 16-bit PCM at this rate. */
export const ESPEAK_SAMPLE_RATE = 22050;
/** Upper bound for one engine output file (≈ 45 min of mono 22.05 kHz s16). */
const MAX_ENGINE_WAV_BYTES = 120 * 1024 * 1024;

/**
 * eSpeak NG reads `[[...]]` as raw phoneme input. User text must never reach the engine as
 * phoneme syntax, so repeated brackets are collapsed. Phoneme overrides from the pronunciation
 * dictionary are inserted after this step via `espeakPhonemeSpan`.
 */
export function sanitizeEspeakText(text: string): string {
  return text
    .replace(/\[{2,}/g, '[')
    .replace(/\]{2,}/g, ']')
    .replaceAll('\0', '');
}

/** Characters allowed in eSpeak phoneme mnemonics supplied through the pronunciation dictionary. */
const ESPEAK_PHONEME_RE = /^[A-Za-z0-9@'",:;_!#%&*+\-/<=>?^|~.\s()]{1,200}$/;
export function isValidEspeakPhonemes(s: string): boolean {
  return ESPEAK_PHONEME_RE.test(s) && !s.includes('[') && !s.includes(']');
}
export function espeakPhonemeSpan(phonemes: string): string {
  if (!isValidEspeakPhonemes(phonemes))
    throw new VoxError(ErrorCodes.PRONUNCIATION_INVALID, 'Phoneme string contains unsupported characters.');
  return `[[${phonemes.trim()}]]`;
}

export function rateToWpm(rate: number): number {
  return Math.min(450, Math.max(80, Math.round(ESPEAK_DEFAULT_WPM * rate)));
}

export interface EspeakAdapterOptions {
  executable: string;
  approvedVersion: string;
}

export class EspeakAdapter implements TtsEngineAdapter {
  readonly engineId = ESPEAK_ENGINE_ID;
  private version: string | null = null;
  private variants: string[] | null = null;

  constructor(private readonly opts: EspeakAdapterOptions) {}

  async detectVersion(): Promise<string> {
    if (this.version) return this.version;
    const r = await runProcess(this.opts.executable, ['--version'], { timeoutMs: 10_000 });
    const m = /text-to-speech:\s*([0-9][\w.-]*)/.exec(r.stdout.toString('utf8'));
    if (r.code !== 0 || !m?.[1])
      throw new VoxError(ErrorCodes.ENGINE_UNAVAILABLE, 'eSpeak NG did not report a version.');
    this.version = m[1];
    return this.version;
  }

  async initialize(): Promise<void> {
    await this.listVariants();
  }

  async getMetadata(): Promise<EngineMetadata> {
    const version = await this.detectVersion();
    const voices = await this.listInstalledVoices();
    return {
      id: ESPEAK_ENGINE_ID,
      name: 'eSpeak NG',
      version,
      synthesisMethod:
        'Rule-based formant synthesis (eSpeak NG formant back-end; Klatt variants). MBROLA disabled.',
      complianceStatus: version === this.opts.approvedVersion ? 'approved' : 'unverified',
      license: 'GPL-3.0-or-later',
      supportedLocales: [...new Set(voices.map((v) => v.nativeId))],
      limitations: ESPEAK_LIMITATIONS,
      notes: 'MBROLA voices are not enabled.',
      admissionRecord: 'docs/decisions/0002-espeak-ng-engine-admission.md',
      verifiedAt: '2026-10-31T00:00:00Z',
    };
  }

  async listInstalledVoices(): Promise<InstalledVoice[]> {
    const r = await runProcess(this.opts.executable, ['--voices'], { timeoutMs: 15_000 });
    return parseEspeakVoiceList(r.stdout.toString('utf8')).filter((v) => !isMbrolaFile(v.file));
  }

  async listVariants(): Promise<string[]> {
    if (this.variants) return this.variants;
    const r = await runProcess(this.opts.executable, ['--voices=variant'], { timeoutMs: 15_000 });
    const files = parseEspeakVoiceList(r.stdout.toString('utf8')).map((v) => v.file.replace(/^!v[\\/]/, ''));
    this.variants = ESPEAK_VARIANTS.map((v) => v.value).filter((v) => v !== 'default' && files.includes(v));
    return this.variants;
  }

  getCapabilities(_nativeVoiceId: string): VoiceCapabilities {
    return espeakCapabilities(this.variants ?? ESPEAK_VARIANTS.map((v) => v.value));
  }

  buildArgs(input: SynthesisInput, textFile: string, wavFile: string | null): string[] {
    const s = input.settings;
    const voice =
      s.variant && s.variant !== 'default' ? `${input.nativeVoiceId}+${s.variant}` : input.nativeVoiceId;
    const args = [
      '-D',
      '-b',
      '1',
      '-z',
      '-v',
      voice,
      '-s',
      String(rateToWpm(s.rate)),
      '-p',
      String(Math.round(s.pitch)),
      '-P',
      String(Math.round(s.pitchRange)),
      '-a',
      '100',
    ];
    const gap = Math.round(s.wordGapMs / 10);
    if (gap > 0) args.push('-g', String(gap));
    args.push('-f', textFile);
    if (wavFile) args.push('-w', wavFile);
    return args;
  }

  async synthesize(input: SynthesisInput, ctx: EngineContext): Promise<EngineAudioOutput> {
    if (!/^[a-z0-9-]{2,40}$/i.test(input.nativeVoiceId))
      throw new VoxError(ErrorCodes.VOICE_NOT_AVAILABLE, 'Invalid voice.');
    const variants = await this.listVariants();
    if (input.settings.variant !== 'default' && !variants.includes(input.settings.variant))
      throw new VoxError(ErrorCodes.PARAMETER_UNSUPPORTED, 'The selected voice variant is not installed.');
    const version = await this.detectVersion();
    const stamp = `${process.hrtime.bigint()}`;
    const textFile = path.join(ctx.tempDir, `in-${stamp}.txt`);
    const wavFile = path.join(ctx.tempDir, `engine-${stamp}.wav`);
    await writeFile(textFile, sanitizeEspeakText(input.text), 'utf8');
    const args = this.buildArgs(input, textFile, wavFile);
    const r = await runProcess(this.opts.executable, args, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    if (r.code !== 0) {
      throw new VoxError(ErrorCodes.SYNTHESIS_FAILED, 'eSpeak NG failed to synthesize this text.', {
        tool: redactToolOutput(r.stderr),
      });
    }
    let buf: Buffer;
    try {
      buf = readFileSync(wavFile);
    } catch {
      throw new VoxError(ErrorCodes.SYNTHESIS_FAILED, 'eSpeak NG produced no audio.');
    }
    if (buf.length > MAX_ENGINE_WAV_BYTES)
      throw new VoxError(ErrorCodes.SYNTHESIS_FAILED, 'Engine output exceeded the size limit.');
    const info = parseWavHeader(buf);
    if (info.audioFormat !== 1 || info.bitsPerSample !== 16 || info.channels !== 1)
      throw new VoxError(ErrorCodes.OUTPUT_VALIDATION_FAILED, 'Unexpected engine audio format.');
    return {
      filePath: wavFile,
      codec: 'pcm_s16le',
      sampleRate: info.sampleRate,
      channels: info.channels,
      durationMs: info.durationMs,
      // Record args without temp paths for reproducibility snapshots.
      engine: {
        id: ESPEAK_ENGINE_ID,
        version,
        nativeVoiceId: input.nativeVoiceId,
        args: args.filter((a) => a !== textFile && a !== wavFile),
      },
    };
  }

  async phonemes(text: string, nativeVoiceId: string, ctx: EngineContext): Promise<string> {
    if (!/^[a-z0-9-]{2,40}$/i.test(nativeVoiceId))
      throw new VoxError(ErrorCodes.VOICE_NOT_AVAILABLE, 'Invalid voice.');
    const textFile = path.join(ctx.tempDir, `ph-${process.hrtime.bigint()}.txt`);
    await writeFile(textFile, sanitizeEspeakText(text), 'utf8');
    const r = await runProcess(
      this.opts.executable,
      ['-q', '-x', '--ipa', '-b', '1', '-v', nativeVoiceId, '-f', textFile],
      {
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      },
    );
    if (r.code !== 0) throw new VoxError(ErrorCodes.SYNTHESIS_FAILED, 'Phoneme transcription failed.');
    return r.stdout.toString('utf8').trim();
  }

  /** Raw eSpeak mnemonics (`-x`), used by QA to detect language switches such as `(en)`. */
  async mnemonics(text: string, nativeVoiceId: string, ctx: EngineContext): Promise<string> {
    const textFile = path.join(ctx.tempDir, `mn-${process.hrtime.bigint()}.txt`);
    await writeFile(textFile, sanitizeEspeakText(text), 'utf8');
    const r = await runProcess(
      this.opts.executable,
      ['-q', '-x', '-b', '1', '-v', nativeVoiceId, '-f', textFile],
      { timeoutMs: ctx.timeoutMs },
    );
    return r.stdout.toString('utf8').trim();
  }

  async healthCheck(): Promise<EngineHealth> {
    try {
      const version = await this.detectVersion();
      if (version !== this.opts.approvedVersion)
        return {
          ok: false,
          version,
          detail: `Installed eSpeak NG ${version} is not the approved version ${this.opts.approvedVersion}.`,
        };
      return { ok: true, version, detail: `eSpeak NG ${version}` };
    } catch (e) {
      return {
        ok: false,
        version: null,
        detail: e instanceof VoxError ? e.message : 'eSpeak NG is not available.',
      };
    }
  }
}

export function isMbrolaFile(file: string): boolean {
  return /(^|[\\/])mb[\\/]/.test(file) || /mbrola/i.test(file);
}

/** Parse `espeak-ng --voices` table output. */
export function parseEspeakVoiceList(out: string): InstalledVoice[] {
  const voices: InstalledVoice[] = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const m = /^\s*\d+\s+(\S+)\s+\S+\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) continue;
    voices.push({ nativeId: m[1]!, languageName: m[2]!.replace(/_/g, ' '), file: m[3]!.replace(/\\/g, '/') });
  }
  return voices;
}
