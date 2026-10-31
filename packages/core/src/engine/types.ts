import type {
  DatasetReportDto,
  PhoneticInventoryDto,
  SynthesisSettings,
  VoiceCapabilities,
} from '@voxstudio/contracts';

export interface EngineMetadata {
  id: string;
  name: string;
  version: string;
  synthesisMethod: string;
  complianceStatus: 'approved' | 'unverified' | 'rejected';
  /** True when the engine runs an AI model (ADR 0008); omitted/false for rule-based and concatenative engines. */
  usesAi?: boolean;
  license: string;
  supportedLocales: string[];
  /** Honest, user-facing limitations of this engine (shown in the voice inspector). */
  limitations: string[];
  /** Operator-facing notes (e.g. what is deliberately not enabled). */
  notes: string;
  /** Path of the admission record (docs/decisions/...) required by docs/07 before enabling. */
  admissionRecord: string;
  /** ISO date the admission record was last reviewed. */
  verifiedAt: string;
}

/** A voice the engine reports as installed (before allowlist/QA reconciliation). */
export interface InstalledVoice {
  /** Engine-native voice selector, e.g. `en-us`. */
  nativeId: string;
  languageName: string;
  /** Engine data file, e.g. `gmw/en-US`; used for diagnostics only. */
  file: string;
}

export interface VoiceMetadata {
  id: string;
  engineId: string;
  name: string;
  locale: string;
  accent?: string;
  packageVersion: string;
  license: string;
  qaStatus: 'untested' | 'testing' | 'passed' | 'failed';
}

export interface SynthesisInput {
  /** Engine-ready text (normalized, pronunciation-substituted, no pause markers). */
  text: string;
  /** Engine-native voice selector. */
  nativeVoiceId: string;
  settings: SynthesisSettings;
}

export interface EngineContext {
  /** Per-job temp directory owned by the caller; adapter writes only inside it. */
  tempDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Scheduling priority of the job asking for this audio (higher goes first in shared engine queues). */
  priority?: number;
}

export interface EngineAudioOutput {
  filePath: string;
  codec: 'pcm_s16le';
  sampleRate: number;
  channels: number;
  durationMs: number;
  engine: { id: string; version: string; nativeVoiceId: string; args: string[] };
}

export interface EngineHealth {
  ok: boolean;
  version: string | null;
  detail: string;
}

/** Engine-supplied facts about one voice, merged into the voice profile by the catalog. */
export interface EngineVoiceProfile {
  /** Regional accent the voice data actually represents; overrides the allowlist label. */
  region: string | null;
  /** Verified speaker gender (null when unknown or not applicable). */
  gender: 'female' | 'male' | null;
  voiceDatabaseVersion: string;
  inventory: PhoneticInventoryDto;
  /** Recorded-unit datasets only; null for rule-based/formant voices. */
  dataset: DatasetReportDto | null;
}

export interface TtsEngineAdapter {
  readonly engineId: string;
  /** Optional engines never block application readiness when they are down. */
  readonly optional?: boolean;
  /** Optional: profile facts that only the engine can know (dataset, inventory, accent). */
  getVoiceProfile?(nativeVoiceId: string): EngineVoiceProfile;
  /** Load engine-specific manifests (e.g. voice variants). Called once before use. */
  initialize(): Promise<void>;
  getMetadata(): Promise<EngineMetadata>;
  listInstalledVoices(): Promise<InstalledVoice[]>;
  getCapabilities(nativeVoiceId: string): VoiceCapabilities;
  synthesize(input: SynthesisInput, context: EngineContext): Promise<EngineAudioOutput>;
  /** Deterministic phoneme transcription for the normalization/pronunciation preview. */
  phonemes(text: string, nativeVoiceId: string, context: EngineContext): Promise<string>;
  healthCheck(): Promise<EngineHealth>;
}
