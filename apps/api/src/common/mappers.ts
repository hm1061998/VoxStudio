import type {
  AssetSummaryDto,
  ErrorCode,
  JobStatus,
  OutputProfile,
  RenderJobDto,
  TimelineEntryDto,
} from '@voxstudio/contracts';
import type { AudioAsset, RenderJob } from '@voxstudio/db';

/** Engines and voices recorded in an asset's engine snapshot (single segment or multi-segment export). */
export function assetProvenance(snapshot: unknown): { engines: string[]; voices: string[] } {
  const s = (snapshot ?? {}) as {
    engineId?: string;
    engineVersion?: string;
    voiceId?: string;
    engines?: string[];
    segments?: { voiceId?: string }[];
  };
  const engines = Array.isArray(s.engines)
    ? s.engines
    : s.engineId
      ? [`${s.engineId}@${s.engineVersion ?? 'unknown'}`]
      : [];
  const voices = [
    ...new Set([s.voiceId, ...(s.segments ?? []).map((x) => x.voiceId)].filter((v): v is string => !!v)),
  ];
  return { engines, voices };
}

export function assetDto(a: AudioAsset): AssetSummaryDto {
  return {
    ...assetProvenance(a.engineSnapshotJson),
    id: a.id,
    format: a.format,
    sampleRate: a.sampleRate,
    channels: a.channels,
    bitDepth: a.bitDepth,
    bitrateKbps: a.bitrate,
    durationMs: a.durationMs,
    fileSizeBytes: a.fileSizeBytes,
    createdAt: a.createdAt.toISOString(),
  };
}

export function jobDto(j: RenderJob, asset: AudioAsset | null): RenderJobDto {
  const plan = j.renderPlanJson as { outputProfile?: OutputProfile };
  return {
    id: j.id,
    projectId: j.projectId ?? '',
    segmentId: j.segmentId,
    kind: j.kind as RenderJobDto['kind'],
    purpose: j.purpose as RenderJobDto['purpose'],
    status: j.status as JobStatus,
    progressUnits: j.progressUnits,
    totalUnits: j.totalUnits,
    attempts: j.attempts,
    errorCode: (j.errorCode as ErrorCode | null) ?? null,
    errorMessage: j.errorMessageSafe,
    outputProfile: plan.outputProfile ?? { format: 'wav', sampleRate: 22050, channels: 1 },
    resultAsset: asset ? assetDto(asset) : null,
    timeline: (asset?.timelineJson as TimelineEntryDto[] | null) ?? null,
    warnings: Array.isArray(j.warningsJson) ? (j.warningsJson as string[]) : [],
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
  };
}
