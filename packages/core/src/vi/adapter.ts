import { mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ErrorCodes, VoxError, type VoiceCapabilities } from '@voxstudio/contracts';
import { CANONICAL_SAMPLE_RATE } from '../audio/dsp';
import { encodeWavPcm16 } from '../audio/wav';
import { espeakCapabilities } from '../engine/capabilities';
import type {
  EngineVoiceProfile,
  EngineAudioOutput,
  EngineContext,
  EngineHealth,
  EngineMetadata,
  InstalledVoice,
  SynthesisInput,
  TtsEngineAdapter,
} from '../engine/types';
import { buildDatasetReport, COMPONENT_INVENTORY, type BenchSyllableList } from './dataset';
import { PROFILES, pronounce } from './profiles';
import { analyzeVietnamese } from './text';
import { synthesizeVietnamese } from './synth';
import { UnitDb } from './unitdb';

export const VNUNIT_ENGINE_ID = 'vnunit';
export const VNUNIT_VERSION = '0.1.0';

export const VNUNIT_LIMITATIONS = [
  'Concatenative synthesis from recorded syllables: quality depends entirely on the recordings in the unit database.',
  'A syllable without a recording is reported as an error; it is never replaced by another syllable.',
  'Words that are not Vietnamese (e.g. English) must be added to the pronunciation dictionary with a Vietnamese spelling.',
  'Intonation is rule-based (declination, final fall, question rise, emphasis); it is not emotional acting.',
  'Pronunciation-dictionary entries written as eSpeak phonemes are not supported by this engine.',
];

export interface VnUnitAdapterOptions {
  /** Directory containing one unit database per sub-directory (each with manifest.json), or a single database directory. */
  dbRoot: string;
  /** Syllables needed by the benchmark corpus; enables corpus coverage in dataset reports. */
  bench?: BenchSyllableList | null;
}

/**
 * Engine adapter for the Vietnamese unit-selection synthesizer. Registered only when a unit database
 * is configured. It is marked `unverified`: no listening evaluation has been done, so it is not
 * production-ready and its voices stay hidden until an operator allowlists and QA-passes them.
 */
export class VnUnitAdapter implements TtsEngineAdapter {
  readonly engineId = VNUNIT_ENGINE_ID;
  private dbs = new Map<string, UnitDb>();

  constructor(private readonly opts: VnUnitAdapterOptions) {}

  private dirs(): string[] {
    const root = this.opts.dbRoot;
    if (existsSync(path.join(root, 'manifest.json'))) return [root];
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, 'manifest.json')))
      .map((e) => path.join(root, e.name))
      .sort();
  }

  async initialize(): Promise<void> {
    this.dbs.clear();
    for (const dir of this.dirs()) {
      const db = UnitDb.load(dir);
      this.dbs.set(db.manifest.id, db);
    }
  }

  private db(nativeVoiceId: string): UnitDb {
    const db = this.dbs.get(nativeVoiceId);
    if (!db)
      throw new VoxError(ErrorCodes.VOICE_NOT_AVAILABLE, 'The selected voice is not installed.', {
        voiceId: nativeVoiceId,
      });
    return db;
  }

  async getMetadata(): Promise<EngineMetadata> {
    return {
      id: VNUNIT_ENGINE_ID,
      name: 'VoxStudio Vietnamese unit selection',
      version: VNUNIT_VERSION,
      synthesisMethod:
        'Rule-based Vietnamese front-end; deterministic tonal-syllable unit selection (Viterbi); TD-PSOLA prosody; no statistical or learned model',
      complianceStatus: 'unverified',
      license: 'Engine: project license. Voice data: see each database manifest.',
      supportedLocales: ['vi-VN'],
      limitations: VNUNIT_LIMITATIONS,
      notes: 'Not production-ready: no listening evaluation has been recorded.',
      admissionRecord: 'docs/decisions/0005-vietnamese-concatenative-engine.md',
      verifiedAt: '2026-10-31T00:00:00Z',
    };
  }

  async listInstalledVoices(): Promise<InstalledVoice[]> {
    return [...this.dbs.values()].map((d) => ({
      nativeId: d.manifest.id,
      languageName: 'Vietnamese',
      file: path.basename(d.dir),
    }));
  }

  getCapabilities(nativeVoiceId: string): VoiceCapabilities {
    this.db(nativeVoiceId);
    const base = espeakCapabilities([]);
    return {
      ...base,
      variant: {
        ...base.variant,
        support: 'unsupported',
        description: 'Not available: this voice has a single recorded speaking style.',
      },
      rate: {
        ...(base.rate as object),
        description: 'Native: PSOLA duration scaling of the recorded syllables (1× = recorded pace).',
      } as VoiceCapabilities['rate'],
      pitch: {
        ...(base.pitch as object),
        label: 'Base pitch',
        description: 'Native: PSOLA pitch shift (50 = recorded level; about 0.24 semitones per step).',
      } as VoiceCapabilities['pitch'],
      pitchRange: {
        ...(base.pitchRange as object),
        description:
          'Native: scales declination, sentence-final and question contours and emphasis (0 = flat).',
      } as VoiceCapabilities['pitchRange'],
      wordGapMs: {
        ...(base.wordGapMs as object),
        support: 'unsupported',
        description: 'Not supported: Vietnamese words cannot be segmented deterministically from syllables.',
      } as VoiceCapabilities['wordGapMs'],
    };
  }

  getVoiceProfile(nativeVoiceId: string): EngineVoiceProfile {
    const db = this.db(nativeVoiceId);
    const inv = COMPONENT_INVENTORY;
    const dataset = buildDatasetReport(db, this.opts.bench ?? null);
    return {
      region: db.manifest.dialect,
      gender: dataset.speaker.gender,
      voiceDatabaseVersion: dataset.datasetVersion,
      inventory: {
        kind: 'recorded-units',
        onsets: [...inv.onsets.required].filter((o) => !dataset.components.onsets.missing.includes(o)),
        nuclei: [...inv.nuclei.required].filter((o) => !dataset.components.nuclei.missing.includes(o)),
        codas: [...inv.codas.required].filter((o) => !dataset.components.codas.missing.includes(o)),
        tones: [...inv.tones.required].filter((o) => !dataset.components.tones.missing.includes(o)),
        recordedSyllables: dataset.distinctSyllables,
        note: 'Components (orthographic) that occur in the recordings; the unit is the tonal syllable.',
      },
      dataset,
    };
  }

  async synthesize(input: SynthesisInput, ctx: EngineContext): Promise<EngineAudioOutput> {
    if (ctx.signal?.aborted) throw new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.');
    if (input.text.includes('[['))
      throw new VoxError(
        ErrorCodes.PRONUNCIATION_INVALID,
        'eSpeak phoneme overrides are not supported by this engine; use a Vietnamese respelling.',
      );
    const db = this.db(input.nativeVoiceId);
    const s = input.settings;
    const r = synthesizeVietnamese(db, input.text, {
      controls: { rate: s.rate, pitchSt: (s.pitch - 50) * 0.24, pitchRange: s.pitchRange / 50 },
    });
    const { wav } = encodeWavPcm16(r.samples, CANONICAL_SAMPLE_RATE, 1);
    mkdirSync(ctx.tempDir, { recursive: true });
    const filePath = path.join(ctx.tempDir, `vn-${process.hrtime.bigint()}.wav`);
    writeFileSync(filePath, wav);
    return {
      filePath,
      codec: 'pcm_s16le',
      sampleRate: CANONICAL_SAMPLE_RATE,
      channels: 1,
      durationMs: r.durationMs,
      engine: {
        id: VNUNIT_ENGINE_ID,
        version: VNUNIT_VERSION,
        nativeVoiceId: input.nativeVoiceId,
        args: [`db=${db.manifest.id}`, `units=${r.metrics.unitIds.join(',')}`],
      },
    };
  }

  async phonemes(text: string, nativeVoiceId: string): Promise<string> {
    const db = this.db(nativeVoiceId);
    const a = analyzeVietnamese(text, { profile: PROFILES[db.manifest.dialect] });
    return a.phrases
      .map((p) => p.tokens.map((t) => pronounce(t.syllable, PROFILES[db.manifest.dialect]).ipa).join(' '))
      .join(' | ');
  }

  async healthCheck(): Promise<EngineHealth> {
    try {
      if (!this.dbs.size) await this.initialize();
      if (!this.dbs.size) return { ok: false, version: null, detail: 'No unit database found.' };
      return {
        ok: true,
        version: VNUNIT_VERSION,
        detail: `${this.dbs.size} unit database(s), ${[...this.dbs.values()].reduce((n, d) => n + d.units.length, 0)} units`,
      };
    } catch (e) {
      return {
        ok: false,
        version: null,
        detail: e instanceof VoxError ? e.message : 'Unit database could not be loaded.',
      };
    }
  }
}
