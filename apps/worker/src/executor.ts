import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import {
  assembleSegments,
  assetStorageKey,
  encodeAndValidate,
  fileSha256,
  profileWarnings,
  synthesizeSegment,
  withTempDir,
  FORMAT_INFO,
  type AppConfig,
  type EngineRegistry,
  type RenderPlan,
  type SegmentPlan,
  type StorageDriver,
} from '@voxstudio/core';
import { notifyJob, type AudioAsset, type PrismaClient, type RenderJob } from '@voxstudio/db';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { restoreProjectStatus } from './queue';
import type { WorkerLogger } from './logger';

const PREVIEW_TTL_MS = 24 * 3600_000;

export interface ExecutorDeps {
  prisma: PrismaClient;
  registry: EngineRegistry;
  storage: StorageDriver;
  config: AppConfig;
  ffmpegVersion: string;
  /** Installed version of every registered engine, keyed by engine id. */
  engineVersions: Record<string, string>;
  logger: WorkerLogger;
}

/** Executes immutable render plans. Every output is validated before its job is marked succeeded. */
export class JobExecutor {
  constructor(private readonly d: ExecutorDeps) {}

  private async progress(job: RenderJob, units: number): Promise<void> {
    await this.d.prisma.renderJob.update({ where: { id: job.id }, data: { progressUnits: units } });
    await notifyJob(this.d.prisma, job.id, job.workspaceId);
  }

  /** Installed version of an engine; optional engines (AI model service) are asked live because they may start later. */
  private async installedVersion(engineId: string): Promise<string | undefined> {
    const adapter = this.d.registry.get(engineId);
    if (!adapter.optional) return this.d.engineVersions[engineId];
    const h = await adapter.healthCheck();
    if (!h.ok)
      throw new VoxError(
        ErrorCodes.ENGINE_UNAVAILABLE,
        'The AI voice service is not available right now. Try again later or use another voice.',
      );
    return h.version ?? undefined;
  }

  private aiEngines = new Map<string, boolean>();
  private async usesAi(engineId: string): Promise<boolean> {
    if (!this.aiEngines.has(engineId))
      this.aiEngines.set(engineId, !!(await this.d.registry.get(engineId).getMetadata()).usesAi);
    return this.aiEngines.get(engineId)!;
  }

  private async assertRunnable(plan: RenderPlan): Promise<void> {
    // Each segment is validated against the engine it was planned for (mixed-engine plans are valid).
    const installed = new Map<string, string | undefined>();
    for (const id of new Set(plan.segments.map((s) => s.engineId)))
      installed.set(id, await this.installedVersion(id));
    const toolsChanged =
      plan.toolVersions.ffmpeg !== this.d.ffmpegVersion ||
      plan.segments.some((s) => installed.get(s.engineId) !== s.engineVersion);
    if (toolsChanged)
      throw new VoxError(
        ErrorCodes.ENGINE_UNAVAILABLE,
        'Server speech/audio tools changed since this job was planned. Start a new render.',
      );
    const engineIds = [...new Set(plan.segments.map((s) => s.engineId))];
    const engines = await this.d.prisma.ttsEngine.findMany({ where: { id: { in: engineIds } } });
    if (
      engines.length !== engineIds.length ||
      engines.some((e) => !e.enabled || e.complianceStatus !== 'approved')
    )
      throw new VoxError(
        ErrorCodes.ENGINE_DISABLED,
        'The speech engine has been disabled by the administrator.',
      );
    const voiceIds = [...new Set(plan.segments.map((s) => s.voiceId))];
    const enabled = await this.d.prisma.ttsVoice.count({ where: { id: { in: voiceIds }, enabled: true } });
    if (enabled !== voiceIds.length)
      throw new VoxError(
        ErrorCodes.VOICE_NOT_AVAILABLE,
        'A voice used by this job has been disabled by the administrator.',
      );
  }

  /** Meter AI synthesis per workspace and month (only audio that was really generated, not cache hits). */
  private async recordAiUsage(workspaceId: string, seg: SegmentPlan, audioMs: number): Promise<void> {
    const chars = seg.chunks.reduce((n, c) => (c.kind === 'speech' ? n + [...c.text].length : n), 0);
    const month = new Date().toISOString().slice(0, 7);
    await this.d.prisma.aiUsage.upsert({
      where: { workspaceId_month_engineId: { workspaceId, month, engineId: seg.engineId } },
      create: { workspaceId, month, engineId: seg.engineId, chars, audioMs, segments: 1 },
      update: { chars: { increment: chars }, audioMs: { increment: audioMs }, segments: { increment: 1 } },
    });
  }

  /** Reuse a stored asset with the same cache key, or synthesize, validate and store a new one. */
  private async segmentAsset(
    job: RenderJob,
    seg: SegmentPlan,
    signal: AbortSignal,
  ): Promise<{ asset: AudioAsset; warnings: string[]; cached: boolean }> {
    const existing = await this.d.prisma.audioAsset.findMany({
      where: { workspaceId: job.workspaceId, cacheKey: seg.cacheKey, kind: { in: ['segment', 'preview'] } },
      orderBy: { createdAt: 'desc' },
    });
    for (const a of existing) {
      if ((await this.d.storage.size(a.storageKey)) === a.fileSizeBytes) {
        // Promote a previewed asset to a retained segment asset when a project uses it.
        if (job.projectId && a.kind === 'preview')
          await this.d.prisma.audioAsset.update({
            where: { id: a.id },
            data: { kind: 'segment', expiresAt: null, projectId: job.projectId },
          });
        return { asset: a, warnings: [], cached: true };
      }
    }
    const adapter = this.d.registry.get(seg.engineId);
    const caps = adapter.getCapabilities(seg.nativeVoiceId);
    const ai = await this.usesAi(seg.engineId);
    const result = await withTempDir(this.d.config.tempDir, `job-${job.id.slice(0, 8)}`, (dir) =>
      synthesizeSegment({
        chunks: seg.chunks,
        nativeVoiceId: seg.nativeVoiceId,
        settings: seg.settings,
        capabilities: caps,
        adapter,
        ffmpeg: this.d.config.tools.ffmpeg,
        ffmpegVersion: this.d.ffmpegVersion,
        tempDir: dir,
        timeoutMs: ai ? this.d.config.vieneuTimeoutMs : this.d.config.engineTimeoutMs,
        signal,
        priority: job.priority,
      }),
    );
    if (ai) await this.recordAiUsage(job.workspaceId, seg, result.durationMs);
    const id = randomUUID();
    const standalone = !job.projectId;
    const key = assetStorageKey(job.workspaceId, job.projectId ?? job.workspaceId, id, 'wav');
    await this.d.storage.putBuffer(key, result.wav);
    const asset = await this.d.prisma.audioAsset.create({
      data: {
        id,
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        segmentId: seg.segmentId,
        renderJobId: job.id,
        kind: standalone ? 'preview' : 'segment',
        storageKey: key,
        format: 'wav',
        codec: 'pcm_s16le',
        sampleRate: 22050,
        channels: 1,
        bitDepth: 16,
        durationMs: result.durationMs,
        fileSizeBytes: result.wav.length,
        checksumSha256: createHash('sha256').update(result.wav).digest('hex'),
        cacheKey: seg.cacheKey,
        engineSnapshotJson: {
          ...result.engineSnapshot,
          engineVersion: seg.engineVersion,
          voiceId: seg.voiceId,
          locale: seg.locale,
        },
        dspSnapshotJson: result.dspSnapshot as object,
        expiresAt: standalone ? new Date(Date.now() + PREVIEW_TTL_MS) : null,
      },
    });
    return { asset, warnings: result.warnings, cached: false };
  }

  private async linkSegment(seg: SegmentPlan, asset: AudioAsset): Promise<void> {
    if (!seg.segmentId || seg.segmentRevision === null) return;
    // Only link if the segment still has the revision this plan was built from.
    await this.d.prisma.projectSegment.updateMany({
      where: { id: seg.segmentId, revision: seg.segmentRevision },
      data: { latestAudioAssetId: asset.id, lastErrorCode: null, lastErrorMessage: null },
    });
  }

  async run(job: RenderJob, signal: AbortSignal): Promise<{ resultAssetId: string; warnings: string[] }> {
    const plan = job.renderPlanJson as unknown as RenderPlan;
    await this.assertRunnable(plan);
    const warnings = new Set<string>(Array.isArray(job.warningsJson) ? (job.warningsJson as string[]) : []);
    if (plan.kind === 'segment') {
      const seg = plan.segments[0]!;
      const r = await this.segmentAsset(job, seg, signal);
      r.warnings.forEach((w) => warnings.add(w));
      if (plan.matchesSaved) await this.linkSegment(seg, r.asset);
      await this.progress(job, 1);
      return { resultAssetId: r.asset.id, warnings: [...warnings] };
    }

    // Project render: segments (1 unit each) → assembly (1) → encode + validate (1).
    const items: { seg: SegmentPlan; asset: AudioAsset }[] = [];
    let done = 0;
    for (const seg of plan.segments) {
      if (signal.aborted) throw new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.');
      const r = await this.segmentAsset(job, seg, signal);
      r.warnings.forEach((w) => warnings.add(`Segment ${seg.position + 1}: ${w}`));
      await this.linkSegment(seg, r.asset);
      items.push({ seg, asset: r.asset });
      await this.progress(job, ++done);
    }
    profileWarnings(plan.outputProfile).forEach((w) => warnings.add(w));
    return withTempDir(this.d.config.tempDir, `render-${job.id.slice(0, 8)}`, async (dir) => {
      const master = path.join(dir, 'master.wav');
      const asm = await assembleSegments(
        items.map(({ seg, asset }) => ({
          segmentId: seg.segmentId ?? '',
          position: seg.position,
          wavPath: this.d.storage.localPath(asset.storageKey),
          pauseBeforeMs: seg.settings.pauseBeforeMs,
          pauseAfterMs: seg.settings.pauseAfterMs,
        })),
        master,
        plan.joinFadeMs,
      );
      await this.progress(job, ++done);
      if (signal.aborted) throw new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.');
      const fmt = FORMAT_INFO[plan.outputProfile.format];
      const out = path.join(dir, `out.${fmt.ext}`);
      const probe = await encodeAndValidate(
        this.d.config.tools,
        master,
        out,
        plan.outputProfile,
        asm.durationMs,
        { timeoutMs: this.d.config.renderTimeoutMs, signal },
      );
      const { sha256, size } = await fileSha256(out);
      const id = randomUUID();
      const key = assetStorageKey(job.workspaceId, job.projectId!, id, fmt.ext);
      await this.d.storage.putFile(key, out);
      const asset = await this.d.prisma.$transaction(async (tx) => {
        const a = await tx.audioAsset.create({
          data: {
            id,
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            renderJobId: job.id,
            kind: 'export',
            storageKey: key,
            format: plan.outputProfile.format,
            codec: probe.codec,
            sampleRate: probe.sampleRate,
            channels: probe.channels,
            bitDepth: plan.outputProfile.format === 'wav' ? (plan.outputProfile.bitDepth ?? 16) : null,
            bitrate: plan.outputProfile.format === 'wav' ? null : (plan.outputProfile.bitrateKbps ?? 128),
            durationMs: probe.durationMs,
            fileSizeBytes: size,
            checksumSha256: sha256,
            cacheKey: plan.cacheKey,
            engineSnapshotJson: {
              // engineId/engineVersion kept for compatibility with exports created before multi-engine support.
              engineId: plan.segments[0]!.engineId,
              engineVersion: plan.segments[0]!.engineVersion,
              engines: [...new Set(plan.segments.map((s) => `${s.engineId}@${s.engineVersion}`))],
              segments: plan.segments.map((s) => ({
                segmentId: s.segmentId,
                voiceId: s.voiceId,
                cacheKey: s.cacheKey,
              })),
            },
            dspSnapshotJson: {
              ffmpegVersion: plan.toolVersions.ffmpeg,
              joinFadeMs: plan.joinFadeMs,
              outputProfile: plan.outputProfile,
              assemblyFrames: asm.frames,
            },
            timelineJson: asm.timeline as object,
          },
        });
        await tx.project.updateMany({
          where: { id: job.projectId! },
          data: { latestExportAssetId: a.id, status: 'rendered' },
        });
        return a;
      });
      await this.progress(job, ++done);
      return { resultAssetId: asset.id, warnings: [...warnings] };
    });
  }

  async onFailure(job: RenderJob, err: VoxError): Promise<void> {
    const plan = job.renderPlanJson as unknown as RenderPlan;
    if (plan.kind === 'segment' && job.segmentId && plan.matchesSaved)
      await this.d.prisma.projectSegment.updateMany({
        where: { id: job.segmentId },
        data: { lastErrorCode: err.code, lastErrorMessage: err.message.slice(0, 300) },
      });
    if (plan.kind === 'project' && job.projectId) await restoreProjectStatus(this.d.prisma, job.projectId);
  }
}
