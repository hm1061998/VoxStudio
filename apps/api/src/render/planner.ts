import { Injectable } from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  normalizeOutputProfile,
  synthesisSettingsSchema,
  type OutputProfile,
} from '@voxstudio/contracts';
import {
  PLAN_VERSION,
  prepareEngineText,
  projectCacheKey,
  segmentCacheKey,
  validateSettingsForVoice,
  type PronunciationRule,
  type RenderPlan,
  type SegmentPlan,
} from '@voxstudio/core';

export type { RenderPlan, SegmentPlan };
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../common/infra';

export interface SegmentLike {
  id: string | null;
  revision: number | null;
  position: number;
  sourceText: string;
  locale: string;
  voiceId: string;
  settings: unknown;
}

export function toRules(
  rows: {
    id: string;
    locale: string;
    matchText: string;
    replacementText: string;
    phonemeFormat: string | null;
    engineScope: string | null;
    caseSensitive: boolean;
    wholeWord: boolean;
    priority: number;
    enabled: boolean;
    createdAt: Date;
  }[],
): PronunciationRule[] {
  return rows.map((r) => ({
    ...r,
    phonemeFormat: r.phonemeFormat === 'espeak' ? 'espeak' : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Builds immutable, reproducible render plans. Workers execute plans without re-reading segments. */
@Injectable()
export class PlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async rules(workspaceId: string): Promise<PronunciationRule[]> {
    return toRules(await this.prisma.pronunciationEntry.findMany({ where: { workspaceId, enabled: true } }));
  }

  ffmpegVersion(): string {
    const v = this.catalog.ffmpegInfo?.version;
    if (!v)
      throw new VoxError(
        ErrorCodes.ENGINE_UNAVAILABLE,
        'Audio processing tools are unavailable on this server.',
      );
    return v;
  }

  async segmentPlan(s: SegmentLike, rules: PronunciationRule[], maxChars: number): Promise<SegmentPlan> {
    if ([...s.sourceText].length > maxChars)
      throw new VoxError(
        ErrorCodes.TEXT_TOO_LONG,
        `Text exceeds the ${maxChars}-character limit for this operation.`,
        { maxChars },
      );
    const settings = synthesisSettingsSchema.parse(s.settings);
    const { voice, caps, engineVersion } = await this.catalog.resolveSelectable(s.voiceId, s.locale);
    validateSettingsForVoice(settings, caps);
    const prepared = prepareEngineText(s.sourceText, s.locale, voice.engineId, rules);
    if (!prepared.chunks.some((c) => c.kind === 'speech'))
      throw new VoxError(ErrorCodes.EMPTY_TEXT, 'This segment has no speakable text.');
    const ffmpeg = this.ffmpegVersion();
    return {
      segmentId: s.id,
      segmentRevision: s.revision,
      position: s.position,
      engineId: voice.engineId,
      engineVersion,
      voiceId: voice.id,
      nativeVoiceId: voice.nativeId,
      voicePackageVersion: voice.packageVersion,
      locale: s.locale,
      chunks: prepared.chunks,
      settings,
      cacheKey: segmentCacheKey({
        engineId: voice.engineId,
        engineVersion,
        voiceId: voice.id,
        voicePackageVersion: voice.packageVersion,
        locale: s.locale,
        chunks: prepared.chunks,
        settings,
        dspToolVersion: ffmpeg,
      }),
      warnings: prepared.warnings,
    };
  }

  /** Current cache key of a saved segment, or null if it cannot be planned (invalid voice/empty). */
  async currentKey(s: SegmentLike, rules: PronunciationRule[]): Promise<string | null> {
    try {
      return (await this.segmentPlan(s, rules, Number.MAX_SAFE_INTEGER)).cacheKey;
    } catch {
      return null;
    }
  }

  wrapSegment(
    p: SegmentPlan,
    projectId: string | null,
    projectRevision: number | null,
    matchesSaved: boolean,
  ): RenderPlan {
    return {
      version: PLAN_VERSION,
      kind: 'segment',
      projectId,
      projectRevision,
      matchesSaved,
      segments: [p],
      joinFadeMs: 0,
      outputProfile: { format: 'wav', sampleRate: 22050, channels: 1, bitDepth: 16 },
      toolVersions: { engine: p.engineVersion, ffmpeg: this.ffmpegVersion() },
      cacheKey: p.cacheKey,
    };
  }

  async projectPlan(
    project: { id: string; revision: number; workspaceId: string },
    segments: SegmentLike[],
    outputProfile: OutputProfile,
    joinFadeMs: number,
    renderMaxChars: number,
    segmentMaxChars: number,
  ): Promise<RenderPlan> {
    if (!segments.length)
      throw new VoxError(ErrorCodes.NOTHING_TO_RENDER, 'Add at least one segment before rendering.');
    const total = segments.reduce((n, s) => n + [...s.sourceText].length, 0);
    if (total > renderMaxChars)
      throw new VoxError(
        ErrorCodes.TEXT_TOO_LONG,
        `Project text exceeds the ${renderMaxChars}-character render limit.`,
      );
    const ffmpeg = this.ffmpegVersion();
    if (outputProfile.format === 'mp3' && !this.catalog.ffmpegInfo?.encoders.mp3)
      throw new VoxError(
        ErrorCodes.OUTPUT_FORMAT_UNSUPPORTED,
        'MP3 export is not available: the MP3 encoder is not installed.',
      );
    if (outputProfile.format === 'ogg' && !this.catalog.ffmpegInfo?.encoders.vorbis)
      throw new VoxError(
        ErrorCodes.OUTPUT_FORMAT_UNSUPPORTED,
        'OGG export is not available: the Vorbis encoder is not installed.',
      );
    const rules = await this.rules(project.workspaceId);
    const plans: SegmentPlan[] = [];
    for (const s of [...segments].sort((a, b) => a.position - b.position)) {
      try {
        plans.push(await this.segmentPlan(s, rules, segmentMaxChars));
      } catch (e) {
        if (e instanceof VoxError)
          throw new VoxError(e.code, `Segment ${s.position + 1}: ${e.message}`, {
            ...e.details,
            segmentId: s.id,
            position: s.position,
          });
        throw e;
      }
    }
    const profile = normalizeOutputProfile(outputProfile);
    return {
      version: PLAN_VERSION,
      kind: 'project',
      projectId: project.id,
      projectRevision: project.revision,
      matchesSaved: true,
      segments: plans,
      joinFadeMs,
      outputProfile: profile,
      toolVersions: { engine: plans[0]!.engineVersion, ffmpeg },
      cacheKey: projectCacheKey({
        segments: plans.map((p) => ({
          cacheKey: p.cacheKey,
          pauseBeforeMs: p.settings.pauseBeforeMs,
          pauseAfterMs: p.settings.pauseAfterMs,
        })),
        joinFadeMs,
        outputProfile: profile,
        encoderToolVersion: ffmpeg,
      }),
    };
  }
}
