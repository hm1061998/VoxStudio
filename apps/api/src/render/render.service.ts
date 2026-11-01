import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCodes,
  VoxError,
  synthesisSettingsSchema,
  type OutputProfile,
  type PlanDto,
  type RenderJobDto,
  type SynthesisSettings,
} from '@voxstudio/contracts';
import { defaultSettings, isPlanId, usageMonth, type AppConfig, type PlanLimits } from '@voxstudio/core';
import { CatalogService } from '../catalog/catalog.service';
import { Prisma, notifyJob, type RenderJob } from '@voxstudio/db';
import { AccessService } from '../common/access';
import { CONFIG, PrismaService } from '../common/infra';
import { jobDto } from '../common/mappers';
import type { SessionUser } from '../common/http';
import { ProjectsService } from '../projects/projects.service';
import { PlannerService, type RenderPlan } from './planner';

@Injectable()
export class RenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly planner: PlannerService,
    private readonly projects: ProjectsService,
    private readonly catalog: CatalogService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async toDto(job: RenderJob): Promise<RenderJobDto> {
    const asset = job.resultAssetId
      ? await this.prisma.audioAsset.findUnique({ where: { id: job.resultAssetId } })
      : null;
    return jobDto(job, asset);
  }

  /** Limits of the workspace's plan (unknown plan names fall back to the free plan). */
  async planLimits(workspaceId: string): Promise<{ plan: string; limits: PlanLimits }> {
    const w = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
    const plan = w && isPlanId(w.plan) ? w.plan : 'free';
    return { plan, limits: this.config.planLimits[plan] };
  }

  async planFor(user: SessionUser): Promise<PlanDto> {
    const workspaceId = this.access.defaultWorkspace(user);
    const { plan, limits } = await this.planLimits(workspaceId);
    const month = usageMonth();
    const [agg, pending, stored] = await Promise.all([
      this.prisma.aiUsage.aggregate({ where: { workspaceId, month }, _sum: { chars: true } }),
      this.prisma.renderJob.count({ where: { workspaceId, status: { in: ['queued', 'running'] } } }),
      this.prisma.audioAsset.aggregate({ where: { workspaceId }, _sum: { fileSizeBytes: true } }),
    ]);
    return {
      workspaceId,
      plan: plan as PlanDto['plan'],
      priority: limits.priority,
      maxPendingJobs: Math.min(limits.maxPendingJobs, this.config.queueMaxPendingPerWorkspace),
      pendingJobs: pending,
      aiMonthlyChars: limits.aiMonthlyChars,
      aiUsedChars: agg._sum.chars ?? 0,
      storageBytes: limits.storageBytes,
      storageUsedBytes: stored._sum.fileSizeBytes ?? 0,
      month,
    };
  }

  /**
   * AI engines are metered per workspace and month. Only text that will really be synthesized counts: segments
   * whose audio is already stored (same cache key) cost nothing.
   */
  private async enforceAiQuota(workspaceId: string, plan: RenderPlan, limits: PlanLimits): Promise<void> {
    if (limits.aiMonthlyChars === null) return;
    const ai = plan.segments.filter((s) => this.catalog.engineUsesAi(s.engineId));
    if (!ai.length) return;
    const unique = new Map(ai.map((s) => [s.cacheKey, s]));
    const stored = await this.prisma.audioAsset.findMany({
      where: { workspaceId, cacheKey: { in: [...unique.keys()] }, kind: { in: ['segment', 'preview'] } },
      select: { cacheKey: true },
    });
    const have = new Set(stored.map((a) => a.cacheKey));
    let needed = 0;
    for (const [key, s] of unique)
      if (!have.has(key)) for (const c of s.chunks) if (c.kind === 'speech') needed += [...c.text].length;
    if (needed === 0) return;
    const month = usageMonth();
    const agg = await this.prisma.aiUsage.aggregate({
      where: { workspaceId, month },
      _sum: { chars: true },
    });
    const used = agg._sum.chars ?? 0;
    if (used + needed > limits.aiMonthlyChars)
      throw new VoxError(
        ErrorCodes.QUOTA_EXCEEDED,
        'This would exceed the monthly allowance for AI voices on your plan. Use a non-AI voice or upgrade.',
        { month, used, needed, limit: limits.aiMonthlyChars },
      );
  }

  /** New audio is refused once the workspace has used its stored-audio allowance (cached results still play). */
  private async enforceStorageQuota(workspaceId: string, limits: PlanLimits): Promise<void> {
    const agg = await this.prisma.audioAsset.aggregate({
      where: { workspaceId },
      _sum: { fileSizeBytes: true },
    });
    const used = agg._sum.fileSizeBytes ?? 0;
    if (used >= limits.storageBytes)
      throw new VoxError(
        ErrorCodes.STORAGE_QUOTA_EXCEEDED,
        'Your stored audio has reached the limit of your plan. Delete old projects or exports, or ask an administrator for a larger plan.',
        { used, limit: limits.storageBytes },
      );
  }

  private async enforceQueueLimit(workspaceId: string, limits: PlanLimits): Promise<void> {
    const pending = await this.prisma.renderJob.count({
      where: { workspaceId, status: { in: ['queued', 'running'] } },
    });
    if (pending >= Math.min(limits.maxPendingJobs, this.config.queueMaxPendingPerWorkspace))
      throw new VoxError(
        ErrorCodes.QUEUE_FULL,
        'Too many render jobs are already queued. Wait for some to finish.',
        { pending },
      );
  }

  /**
   * Create a job, or complete it immediately from cache when an asset for the identical plan
   * already exists (so re-rendering unchanged content is instant and creates no new asset).
   */
  private async enqueue(
    user: SessionUser,
    workspaceId: string,
    data: {
      projectId: string | null;
      segmentId: string | null;
      kind: 'segment' | 'project';
      purpose: string;
      plan: RenderPlan;
      totalUnits: number;
    },
  ): Promise<RenderJobDto> {
    const cacheKind = data.kind === 'project' ? 'export' : data.projectId ? 'segment' : 'preview';
    const cached = await this.prisma.audioAsset.findFirst({
      where: {
        workspaceId,
        cacheKey: data.plan.cacheKey,
        kind: data.kind === 'project' ? 'export' : { in: ['segment', 'preview'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const warnings = [...new Set(data.plan.segments.flatMap((s) => s.warnings))];
    if (cached) {
      const job = await this.prisma.$transaction(async (tx) => {
        const j = await tx.renderJob.create({
          data: {
            projectId: data.projectId,
            workspaceId,
            segmentId: data.segmentId,
            requestedByUserId: user.id,
            kind: data.kind,
            purpose: data.purpose,
            status: 'succeeded',
            progressUnits: data.totalUnits,
            totalUnits: data.totalUnits,
            renderPlanJson: data.plan as unknown as Prisma.InputJsonValue,
            cacheKey: data.plan.cacheKey,
            resultAssetId: cached.id,
            warningsJson: [
              ...warnings,
              'Served from render cache: inputs are identical to a previous render.',
            ],
            startedAt: new Date(),
            completedAt: new Date(),
          },
        });
        if (data.segmentId && data.plan.matchesSaved && cacheKind === 'segment')
          await tx.projectSegment.update({
            where: { id: data.segmentId },
            data: { latestAudioAssetId: cached.id, lastErrorCode: null, lastErrorMessage: null },
          });
        if (data.kind === 'project' && data.projectId)
          await tx.project.update({
            where: { id: data.projectId },
            data: { latestExportAssetId: cached.id, status: 'rendered' },
          });
        await notifyJob(tx, j.id, workspaceId);
        return j;
      });
      return this.toDto(job);
    }
    const { limits } = await this.planLimits(workspaceId);
    await this.enforceQueueLimit(workspaceId, limits);
    await this.enforceStorageQuota(workspaceId, limits);
    await this.enforceAiQuota(workspaceId, data.plan, limits);
    const job = await this.prisma.$transaction(async (tx) => {
      const j = await tx.renderJob.create({
        data: {
          projectId: data.projectId,
          workspaceId,
          segmentId: data.segmentId,
          requestedByUserId: user.id,
          kind: data.kind,
          purpose: data.purpose,
          priority: limits.priority,
          totalUnits: data.totalUnits,
          renderPlanJson: data.plan as unknown as Prisma.InputJsonValue,
          cacheKey: data.plan.cacheKey,
          warningsJson: warnings,
        },
      });
      if (data.kind === 'project' && data.projectId)
        await tx.project.update({ where: { id: data.projectId }, data: { status: 'rendering' } });
      await notifyJob(tx, j.id, workspaceId);
      return j;
    });
    return this.toDto(job);
  }

  /** Preview one segment, optionally with unsaved draft values (draft is not persisted). */
  async previewSegment(
    user: SessionUser,
    segmentId: string,
    draft: { sourceText?: string; voiceId?: string; locale?: string; settings?: SynthesisSettings },
    purpose: 'preview' | 'render',
  ): Promise<RenderJobDto> {
    const s = await this.access.segment(user, segmentId);
    const saved = {
      sourceText: s.sourceText,
      voiceId: s.voiceId,
      locale: s.locale,
      settings: synthesisSettingsSchema.parse(s.settingsJson),
    };
    const merged = {
      ...saved,
      ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)),
    } as typeof saved;
    const matchesSaved = JSON.stringify(merged) === JSON.stringify(saved);
    const max = purpose === 'preview' ? this.config.previewMaxChars : this.config.segmentMaxChars;
    const rules = await this.planner.rules(s.project.workspaceId);
    const segPlan = await this.planner.segmentPlan(
      { id: s.id, revision: s.revision, position: s.position, ...merged },
      rules,
      max,
    );
    const plan = this.planner.wrapSegment(segPlan, s.projectId, s.project.revision, matchesSaved);
    return this.enqueue(user, s.project.workspaceId, {
      projectId: s.projectId,
      segmentId: s.id,
      kind: 'segment',
      purpose,
      plan,
      totalUnits: 1,
    });
  }

  /** Standalone preview (voice library sample, pronunciation check). Assets expire after 24 h. */
  async previewText(
    user: SessionUser,
    input: { text: string; voiceId: string; locale: string; settings?: SynthesisSettings },
  ): Promise<RenderJobDto> {
    const workspaceId = this.access.defaultWorkspace(user);
    const resolved = await this.catalog.resolveSelectable(input.voiceId, input.locale);
    const settings = input.settings ?? defaultSettings(resolved.caps);
    const rules = await this.planner.rules(workspaceId);
    const segPlan = await this.planner.segmentPlan(
      {
        id: null,
        revision: null,
        position: 0,
        sourceText: input.text,
        locale: input.locale,
        voiceId: input.voiceId,
        settings,
      },
      rules,
      this.config.previewMaxChars,
    );
    return this.enqueue(user, workspaceId, {
      projectId: null,
      segmentId: null,
      kind: 'segment',
      purpose: 'preview',
      plan: this.planner.wrapSegment(segPlan, null, null, false),
      totalUnits: 1,
    });
  }

  async renderProject(
    user: SessionUser,
    projectId: string,
    revision: number,
    outputProfile: OutputProfile | undefined,
    purpose: 'render' | 'export',
  ): Promise<RenderJobDto> {
    const p = await this.access.project(user, projectId);
    if (p.revision !== revision)
      throw new VoxError(
        ErrorCodes.REVISION_CONFLICT,
        'The project changed since you loaded it. Save or reload, then render again.',
        { currentRevision: p.revision },
      );
    const settings = this.projects.parseSettings(p.settingsJson);
    const profile = outputProfile ?? settings.outputProfile;
    const segments = await this.prisma.projectSegment.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
    });
    const plan = await this.planner.projectPlan(
      p,
      segments.map((s) => this.projects.segmentLike(s)),
      profile,
      settings.joinFadeMs,
      this.config.renderMaxChars,
      this.config.segmentMaxChars,
    );
    if (outputProfile)
      await this.prisma.project.update({
        where: { id: projectId },
        data: { settingsJson: { ...settings, outputProfile } },
      });
    // Units: one per segment + assembly + encode/validate.
    return this.enqueue(user, p.workspaceId, {
      projectId,
      segmentId: null,
      kind: 'project',
      purpose,
      plan,
      totalUnits: segments.length + 2,
    });
  }

  async get(user: SessionUser, jobId: string): Promise<RenderJobDto> {
    return this.toDto(await this.access.job(user, jobId));
  }

  async listForProject(user: SessionUser, projectId: string): Promise<RenderJobDto[]> {
    await this.access.project(user, projectId);
    const jobs = await this.prisma.renderJob.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return Promise.all(jobs.map((j) => this.toDto(j)));
  }

  async listRecent(user: SessionUser): Promise<RenderJobDto[]> {
    const jobs = await this.prisma.renderJob.findMany({
      where: { workspaceId: { in: user.workspaceIds }, kind: 'project' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return Promise.all(jobs.map((j) => this.toDto(j)));
  }

  /** Retry re-queues the same job with the same immutable plan; workers reuse cached assets. */
  async retry(user: SessionUser, jobId: string): Promise<RenderJobDto> {
    const j = await this.access.job(user, jobId);
    if (!['failed', 'cancelled'].includes(j.status))
      throw new VoxError(ErrorCodes.JOB_NOT_RETRYABLE, 'Only failed or cancelled jobs can be retried.');
    const { limits } = await this.planLimits(j.workspaceId);
    await this.enforceQueueLimit(j.workspaceId, limits);
    await this.enforceAiQuota(j.workspaceId, j.renderPlanJson as unknown as RenderPlan, limits);
    const updated = await this.prisma.$transaction(async (tx) => {
      const r = await tx.renderJob.updateMany({
        where: { id: jobId, status: { in: ['failed', 'cancelled'] } },
        data: {
          priority: limits.priority,
          status: 'queued',
          progressUnits: 0,
          errorCode: null,
          errorMessageSafe: null,
          cancelRequested: false,
          lockedBy: null,
          lockedUntil: null,
          startedAt: null,
          completedAt: null,
          attempts: 0,
        },
      });
      if (!r.count) throw new VoxError(ErrorCodes.JOB_NOT_RETRYABLE, 'Job state changed; reload.');
      if (j.kind === 'project' && j.projectId)
        await tx.project.update({ where: { id: j.projectId }, data: { status: 'rendering' } });
      await notifyJob(tx, jobId, j.workspaceId);
      return tx.renderJob.findUniqueOrThrow({ where: { id: jobId } });
    });
    return this.toDto(updated);
  }

  async cancel(user: SessionUser, jobId: string): Promise<RenderJobDto> {
    const j = await this.access.job(user, jobId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const queued = await tx.renderJob.updateMany({
        where: { id: jobId, status: 'queued' },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
          errorCode: ErrorCodes.JOB_CANCELLED,
          errorMessageSafe: 'Cancelled by user.',
        },
      });
      if (!queued.count) {
        const running = await tx.renderJob.updateMany({
          where: { id: jobId, status: 'running' },
          data: { cancelRequested: true },
        });
        if (!running.count)
          throw new VoxError(ErrorCodes.JOB_NOT_CANCELLABLE, 'This job has already finished.');
      } else if (j.kind === 'project' && j.projectId) {
        const p = await tx.project.findUnique({ where: { id: j.projectId } });
        if (p)
          await tx.project.update({
            where: { id: p.id },
            data: { status: p.latestExportAssetId ? 'rendered' : 'draft' },
          });
      }
      await notifyJob(tx, jobId, j.workspaceId);
      return tx.renderJob.findUniqueOrThrow({ where: { id: jobId } });
    });
    return this.toDto(updated);
  }
}
