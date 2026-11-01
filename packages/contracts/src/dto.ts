import type { PlanId } from './plans';
import type {
  OutputProfile,
  ParameterSupport,
  SettingKey,
  SynthesisSettings,
  VoiceCapabilities,
  PartialSettings,
} from './settings';
import type { ProjectSettings } from './schemas';
import type { ErrorCode } from './errors';

export type ProjectStatus = 'draft' | 'rendering' | 'rendered' | 'archived';
export type SegmentAudioState = 'missing' | 'stale' | 'queued' | 'rendering' | 'ready' | 'failed';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobKind = 'segment' | 'project';
export type SupportTier = 'verified' | 'experimental' | 'unavailable';

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  workspaces: { id: string; name: string }[];
}

export interface SessionDto {
  user: UserDto;
  csrfToken: string;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetSummaryDto {
  id: string;
  format: string;
  sampleRate: number;
  channels: number;
  bitDepth: number | null;
  bitrateKbps: number | null;
  durationMs: number;
  fileSizeBytes: number;
  createdAt: string;
  /** Engines that produced this audio, as `id@version` (from the stored engine snapshot, not the current catalog). */
  engines?: string[];
  /** Voice ids that produced this audio. */
  voices?: string[];
}

export interface ProjectSummaryDto {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  defaultLocale: string;
  status: ProjectStatus;
  revision: number;
  segmentCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  latestExport: AssetSummaryDto | null;
  lastRenderStatus: JobStatus | null;
}

export interface SegmentDto {
  id: string;
  position: number;
  sourceText: string;
  locale: string;
  voiceId: string;
  settings: SynthesisSettings;
  revision: number;
  audioState: SegmentAudioState;
  audio: AssetSummaryDto | null;
  /** Error from the most recent failed synthesis of this segment, if any. */
  lastError: { code: ErrorCode; message: string } | null;
}

export interface ProjectDto extends ProjectSummaryDto {
  settings: ProjectSettings;
  segments: SegmentDto[];
}

export interface ProjectVersionDto {
  id: string;
  revision: number;
  label: string | null;
  createdAt: string;
  segmentCount: number;
}

export interface EngineDto {
  id: string;
  displayName: string;
  version: string;
  synthesisMethod: string;
  complianceStatus: 'approved' | 'unverified' | 'rejected';
  /** True when the engine runs an AI model (ADR 0008). The UI labels such voices "AI". */
  usesAi: boolean;
  license: string;
  enabled: boolean;
  verifiedAt: string | null;
  notes: string;
  health?: { ok: boolean; detail: string; checkedAt: string };
}

export interface VoiceDto {
  id: string;
  engineId: string;
  displayName: string;
  locale: string;
  languageName: string;
  accent: string | null;
  packageVersion: string;
  license: string;
  enabled: boolean;
  qaStatus: 'untested' | 'testing' | 'passed' | 'failed';
  supportTier: SupportTier;
  qaNotes: string;
  /** True when this voice is produced by an AI model (ADR 0008). */
  usesAi: boolean;
  /** Speaker gender as stated by the voice provider; null when not stated (e.g. rule-based voices). */
  gender: 'female' | 'male' | null;
  /** Only present for admins. */
  installed?: boolean;
}

export interface VoiceDetailDto extends VoiceDto {
  capabilities: VoiceCapabilities;
  qaReport: unknown;
  limitations: string[];
}

/** Task-facing names for how each setting is realised by a voice's engine. */
export type SupportClass = 'ENGINE_NATIVE' | 'DSP_DERIVED' | 'UNSUPPORTED';
export const SUPPORT_CLASS: Record<ParameterSupport, SupportClass> = {
  native: 'ENGINE_NATIVE',
  dsp: 'DSP_DERIVED',
  unsupported: 'UNSUPPORTED',
};

export interface ComponentCoverageDto {
  total: number;
  covered: number;
  missing: string[];
}

/** Auditable description of a recorded-unit dataset. Everything here is measured or taken from the manifest. */
export interface DatasetReportDto {
  schema: 'vn-dataset-report-1';
  datasetId: string;
  datasetVersion: string;
  builtBy: string;
  unitsSha256: string;
  manifestSha256: string;
  units: number;
  distinctSyllables: number;
  /** Syllables with a single recorded instance (no choice for unit selection). */
  singleInstanceSyllables: number;
  components: {
    onsets: ComponentCoverageDto;
    nuclei: ComponentCoverageDto;
    codas: ComponentCoverageDto;
    tones: ComponentCoverageDto;
  };
  unitsPerTone: Record<string, number>;
  /** Coverage of the syllables needed by the versioned benchmark corpus; null when no corpus list is installed. */
  corpus: {
    version: string;
    required: number;
    covered: number;
    coveragePct: number;
    missing: string[];
  } | null;
  recording: {
    format: 'pcm_s16le';
    sampleRate: number;
    channels: 1;
    totalSeconds: number;
    meanUnitMs: number;
    shortUnits: number;
    f0Hz: { p10: number; median: number; p90: number } | null;
    rmsDbfs: { p10: number; median: number; p90: number } | null;
    unvoicedUnits: number;
    notes: string;
  };
  speaker: { gender: 'female' | 'male' | null; genderVerified: boolean; region: string };
  license: { id: string; notes: string; attribution: string };
  /** Where the audio came from. `unknown` means the manifest does not say (older databases). */
  provenance: {
    kind: 'human-recording' | 'ai-generated' | 'unknown';
    generator: { name: string; version: string; license: string; localRun: boolean } | null;
    notes: string;
  };
  /** True only when every phonetic component and every benchmark-corpus syllable is covered. */
  complete: boolean;
  warnings: string[];
}

export interface DatasetHistoryDto {
  datasetVersion: string;
  manifestSha256: string;
  licenseId: string;
  recordedAt: string;
}

export interface PhoneticInventoryDto {
  kind: 'rule-based' | 'recorded-units' | 'neural';
  /** Component lists are filled only when the voice's inventory is actually enumerable (recorded units). */
  onsets: string[];
  nuclei: string[];
  codas: string[];
  tones: string[];
  recordedSyllables: number | null;
  note: string;
}

export interface VoiceDefaultsDto {
  rate: number;
  pitch: number;
  volumeDb: number;
  pauseBeforeMs: number;
  pauseAfterMs: number;
}

export interface VoiceProfileDto extends VoiceDetailDto {
  region: string | null;
  /** Only filled where a data provider or reviewer verified it; eSpeak variants are parameter sets, not people. */
  gender: 'female' | 'male' | null;
  engineName: string;
  engineVersion: string;
  synthesisMethod: string;
  voiceDatabaseVersion: string;
  inventory: PhoneticInventoryDto;
  defaults: VoiceDefaultsDto;
  controls: Record<SettingKey, SupportClass>;
  sample: { text: string };
  validation: {
    state: 'unvalidated' | 'automated-passed' | 'automated-failed' | 'reviewed';
    detail: string;
    reviewer: string | null;
    reviewedOn: string | null;
  };
  dataset: DatasetReportDto | null;
  datasetHistory: DatasetHistoryDto[];
}

export interface PresetDto {
  id: string;
  name: string;
  description: string;
  localeScope: string | null;
  parameters: PartialSettings;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PronunciationEntryDto {
  id: string;
  locale: string;
  matchText: string;
  replacementText: string;
  phonemeFormat: 'espeak' | null;
  engineScope: string | null;
  caseSensitive: boolean;
  wholeWord: boolean;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PronunciationConflictDto {
  locale: string;
  matchText: string;
  entryIds: string[];
  /** Entry that wins under the deterministic precedence order. */
  winnerId: string;
}

export interface NormalizationStepDto {
  rule: string;
  from: string;
  to: string;
}

/** Deterministic spelling analysis of Vietnamese text (rule-based; independent of the synthesis engine). */
export interface ToneDiagnosticsDto {
  kind: 'vi-orthography';
  syllables: {
    surface: string;
    syllable: string;
    onset: string;
    glide: string;
    nucleus: string;
    coda: string;
    tone: 'ngang' | 'huyen' | 'sac' | 'hoi' | 'nga' | 'nang';
  }[];
  /** Words the analysis cannot read as Vietnamese (e.g. English words); add them to the pronunciation dictionary. */
  unreadable: string[];
  truncated: boolean;
}

export interface NormalizationPreviewDto {
  original: string;
  normalized: string;
  /** Text actually passed to the engine (after pronunciation substitutions), per chunk. */
  engineChunks: { kind: 'speech' | 'pause'; text?: string; pauseMs?: number }[];
  steps: NormalizationStepDto[];
  pronunciationApplied: { entryId: string; matchText: string; count: number }[];
  phonemes: string;
  /** Present for Vietnamese text. */
  diagnostics?: ToneDiagnosticsDto | null;
  warnings: string[];
}

export interface TimelineEntryDto {
  segmentId: string;
  position: number;
  startMs: number;
  endMs: number;
  speechStartMs: number;
  speechEndMs: number;
}

export interface RenderJobDto {
  id: string;
  projectId: string;
  segmentId: string | null;
  kind: JobKind;
  purpose: 'preview' | 'render' | 'export';
  status: JobStatus;
  progressUnits: number;
  totalUnits: number;
  attempts: number;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  outputProfile: OutputProfile;
  resultAsset: AssetSummaryDto | null;
  timeline: TimelineEntryDto[] | null;
  warnings: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type JobEventType =
  'job.queued' | 'job.started' | 'job.progress' | 'job.succeeded' | 'job.failed' | 'job.cancelled';

export interface JobEventDto {
  type: JobEventType;
  job: RenderJobDto;
}

export interface HealthDto {
  status: 'ok' | 'degraded' | 'fail';
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface AdminUserDto {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  createdAt: string;
  lastLoginAt: string | null;
  workspaceId: string | null;
  plan: PlanId;
  aiUsedChars: number;
  projects: number;
  pendingJobs: number;
  activeSessions: number;
}

export interface AdminUserPageDto {
  items: AdminUserDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminAuditDto {
  id: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorEmail: string | null;
  workspaceId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface AdminOverviewDto {
  /** Accounts, plans and AI usage, for the administrator dashboard. */
  users: { total: number; active: number; suspended: number; admins: number; newLast7Days: number };
  plans: Record<PlanId, number>;
  ai: {
    enabled: boolean;
    service: { ok: boolean; detail: string } | null;
    usedCharsThisMonth: number;
    month: string;
  };
  security: {
    failedSignIns24h: number;
    lockedNow: number;
    activeSessions: number;
    registrationOpen: boolean;
  };
  engines: EngineDto[];
  voices: VoiceDto[];
  storage: { assetCount: number; totalBytes: number; root: 'local' };
  /** Free space of the storage volume (worker measurement). `block` = new audio jobs are refused. */
  disk: {
    state: 'ok' | 'warn' | 'block';
    totalBytes: number;
    freeBytes: number;
    checkedAt: string;
    measuredHere: boolean;
  };
  topWorkspaces: { workspaceId: string; name: string; plan: PlanId; bytes: number }[];
  jobs: { queued: number; running: number; failed24h: number; succeeded24h: number };
  recentFailures: {
    id: string;
    projectId: string;
    errorCode: string | null;
    errorMessage: string | null;
    completedAt: string | null;
  }[];
  worker: { lastHeartbeatAt: string | null; ffmpegVersion: string | null; espeakVersion: string | null };
}
