import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  engineToggleSchema,
  voiceToggleSchema,
  workspacePlanSchema,
  ErrorCodes,
  VoxError,
  type AdminOverviewDto,
  type AdminWorkspaceDto,
} from '@voxstudio/contracts';
import { isPlanId, usageMonth } from '@voxstudio/core';
import { z } from 'zod';
import { AdminOnly } from '../auth/guards';
import { CatalogService } from '../catalog/catalog.service';
import { CurrentUser, UuidPipe, ZodPipe, type SessionUser } from '../common/http';
import { PrismaService } from '../common/infra';

@AdminOnly()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  @Get('overview')
  async overview(): Promise<AdminOverviewDto> {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [queued, running, failed24h, succeeded24h, storage, failures, hb] = await Promise.all([
      this.prisma.renderJob.count({ where: { status: 'queued' } }),
      this.prisma.renderJob.count({ where: { status: 'running' } }),
      this.prisma.renderJob.count({ where: { status: 'failed', completedAt: { gte: since } } }),
      this.prisma.renderJob.count({ where: { status: 'succeeded', completedAt: { gte: since } } }),
      this.prisma.audioAsset.aggregate({ _count: true, _sum: { fileSizeBytes: true } }),
      this.prisma.renderJob.findMany({
        where: { status: 'failed' },
        orderBy: { completedAt: 'desc' },
        take: 20,
      }),
      this.prisma.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: 'desc' } }),
    ]);
    const info = (hb?.infoJson ?? {}) as { ffmpegVersion?: string; espeakVersion?: string };
    return {
      engines: await this.catalog.engines(),
      voices: await this.catalog.listVoices({ admin: true }),
      storage: { assetCount: storage._count, totalBytes: storage._sum.fileSizeBytes ?? 0, root: 'local' },
      jobs: { queued, running, failed24h, succeeded24h },
      recentFailures: failures.map((f) => ({
        id: f.id,
        projectId: f.projectId ?? '',
        errorCode: f.errorCode,
        errorMessage: f.errorMessageSafe,
        completedAt: f.completedAt?.toISOString() ?? null,
      })),
      worker: {
        lastHeartbeatAt: hb?.lastSeenAt.toISOString() ?? null,
        ffmpegVersion: info.ffmpegVersion ?? null,
        espeakVersion: info.espeakVersion ?? null,
      },
    };
  }

  @Patch('engines/:engineId')
  async toggleEngine(
    @CurrentUser() user: SessionUser,
    @Param('engineId') id: string,
    @Body(new ZodPipe(engineToggleSchema)) body: z.infer<typeof engineToggleSchema>,
  ) {
    const e = await this.prisma.ttsEngine.findUnique({ where: { id } });
    if (!e) throw new VoxError(ErrorCodes.NOT_FOUND, 'Engine not found.');
    if (body.enabled && e.complianceStatus !== 'approved')
      throw new VoxError(
        ErrorCodes.FORBIDDEN,
        'Only engines with an approved compliance record can be enabled.',
      );
    await this.prisma.ttsEngine.update({ where: { id }, data: { enabled: body.enabled } });
    await this.audit(user, 'engine.toggled', 'engine', id, { enabled: body.enabled });
    return (await this.catalog.engines()).find((x) => x.id === id);
  }

  @Patch('voices/:voiceId')
  async toggleVoice(
    @CurrentUser() user: SessionUser,
    @Param('voiceId') id: string,
    @Body(new ZodPipe(voiceToggleSchema)) body: z.infer<typeof voiceToggleSchema>,
  ) {
    const v = this.catalog.findCatalogVoice(id);
    if (!v) throw new VoxError(ErrorCodes.NOT_FOUND, 'Voice not found.');
    if (body.enabled && (v.qaStatus !== 'passed' || !v.installed))
      throw new VoxError(ErrorCodes.FORBIDDEN, 'Only installed voices that passed QA can be enabled.');
    await this.prisma.ttsVoice.update({ where: { id }, data: { enabled: body.enabled } });
    await this.audit(user, 'voice.toggled', 'voice', id, { enabled: body.enabled });
    return (await this.catalog.listVoices({ admin: true })).find((x) => x.id === id);
  }

  /** Workspaces with their plan and this month's AI usage. */
  @Get('workspaces')
  async workspaces(): Promise<AdminWorkspaceDto[]> {
    const month = usageMonth();
    const ws = await this.prisma.workspace.findMany({
      include: { owner: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const usage = await this.prisma.aiUsage.groupBy({
      by: ['workspaceId'],
      where: { month },
      _sum: { chars: true },
    });
    const pending = await this.prisma.renderJob.groupBy({
      by: ['workspaceId'],
      where: { status: { in: ['queued', 'running'] } },
      _count: true,
    });
    const u = new Map(usage.map((x) => [x.workspaceId, x._sum.chars ?? 0]));
    const p = new Map(pending.map((x) => [x.workspaceId, x._count]));
    return ws.map((w) => ({
      id: w.id,
      name: w.name,
      ownerEmail: w.owner.email,
      plan: (isPlanId(w.plan) ? w.plan : 'free') as AdminWorkspaceDto['plan'],
      aiUsedChars: u.get(w.id) ?? 0,
      pendingJobs: p.get(w.id) ?? 0,
    }));
  }

  /** Assign a plan (there is no payment integration: this is the operator's decision). */
  @Patch('workspaces/:workspaceId/plan')
  async setPlan(
    @CurrentUser() user: SessionUser,
    @Param('workspaceId', UuidPipe) id: string,
    @Body(new ZodPipe(workspacePlanSchema)) body: z.infer<typeof workspacePlanSchema>,
  ) {
    const w = await this.prisma.workspace.findUnique({ where: { id } });
    if (!w) throw new VoxError(ErrorCodes.NOT_FOUND, 'Workspace not found.');
    await this.prisma.workspace.update({ where: { id }, data: { plan: body.plan } });
    await this.audit(user, 'workspace.plan_changed', 'workspace', id, { from: w.plan, to: body.plan });
    return { id, plan: body.plan };
  }

  /** Re-read installed voices and QA report (e.g. after running `pnpm qa:voices`). */
  @Post('catalog/refresh')
  async refresh() {
    await this.catalog.refresh();
    return this.catalog.listVoices({ admin: true });
  }

  private async audit(
    user: SessionUser,
    eventType: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) {
    const workspaceId = user.workspaceIds[0];
    if (workspaceId)
      await this.prisma.auditEvent.create({
        data: {
          workspaceId,
          actorUserId: user.id,
          eventType,
          resourceType,
          resourceId,
          metadataJson: metadata as object,
        },
      });
  }
}
