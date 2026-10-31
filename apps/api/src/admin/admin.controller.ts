import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  adminAuditQuerySchema,
  adminUserQuerySchema,
  adminUserUpdateSchema,
  engineToggleSchema,
  voiceToggleSchema,
  workspacePlanSchema,
  ErrorCodes,
  PLAN_IDS,
  VoxError,
  type AdminAuditDto,
  type AdminOverviewDto,
  type AdminUserDto,
  type AdminUserPageDto,
  type AdminWorkspaceDto,
  type PlanId,
} from '@voxstudio/contracts';
import { isPlanId, usageMonth, type AppConfig } from '@voxstudio/core';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly } from '../auth/guards';
import { AuthService } from '../auth/auth.service';
import { CatalogService } from '../catalog/catalog.service';
import { AuditService } from '../common/audit';
import { CurrentUser, UuidPipe, ZodPipe, type SessionUser } from '../common/http';
import { CONFIG, PrismaService } from '../common/infra';

const planOf = (p: string): PlanId => (isPlanId(p) ? p : 'free');

/**
 * Administrator API. Every route requires the admin role (enforced by the global guard through `@AdminOnly`, so a
 * new route here is protected by default). Changes are audited; an administrator cannot change their own role or
 * status, and the last active administrator can never be demoted or suspended.
 */
@AdminOnly()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('overview')
  async overview(): Promise<AdminOverviewDto> {
    const since = new Date(Date.now() - 24 * 3600_000);
    const now = new Date();
    const month = usageMonth();
    const [
      queued,
      running,
      failed24h,
      succeeded24h,
      storage,
      failures,
      hb,
      userCounts,
      newUsers,
      planGroups,
      aiUsage,
      failedSignIns,
      lockedNow,
      sessions,
    ] = await Promise.all([
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
      this.prisma.user.groupBy({ by: ['status', 'role'], _count: true }),
      this.prisma.user.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } } }),
      this.prisma.workspace.groupBy({ by: ['plan'], _count: true }),
      this.prisma.aiUsage.aggregate({ where: { month }, _sum: { chars: true } }),
      this.prisma.authThrottle.aggregate({
        where: { key: { startsWith: 'acct:' }, lastFailureAt: { gte: since } },
        _sum: { failures: true },
      }),
      this.prisma.authThrottle.count({ where: { lockedUntil: { gt: now } } }),
      this.prisma.session.count({ where: { expiresAt: { gt: now } } }),
    ]);
    const info = (hb?.infoJson ?? {}) as { ffmpegVersion?: string; espeakVersion?: string };
    const plans = { free: 0, pro: 0, business: 0 } as Record<PlanId, number>;
    for (const g of planGroups) plans[planOf(g.plan)] += g._count;
    const sum = (f: (g: (typeof userCounts)[number]) => boolean) =>
      userCounts.filter(f).reduce((a, g) => a + g._count, 0);
    const aiEnabled = this.config.enabledEngines.includes('vieneu');
    return {
      users: {
        total: sum(() => true),
        active: sum((g) => g.status === 'active'),
        suspended: sum((g) => g.status === 'suspended'),
        admins: sum((g) => g.role === 'admin'),
        newLast7Days: newUsers,
      },
      plans,
      ai: {
        enabled: aiEnabled,
        service: aiEnabled ? await this.catalog.aiServiceHealth() : null,
        usedCharsThisMonth: aiUsage._sum.chars ?? 0,
        month,
      },
      security: {
        failedSignIns24h: failedSignIns._sum.failures ?? 0,
        lockedNow,
        activeSessions: sessions,
        registrationOpen: this.config.allowRegistration,
      },
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

  // ---- users -----------------------------------------------------------------------------------------------
  @Get('users')
  async users(
    @Query(new ZodPipe(adminUserQuerySchema)) q: z.infer<typeof adminUserQuerySchema>,
  ): Promise<AdminUserPageDto> {
    const where = q.q
      ? {
          OR: [
            { email: { contains: q.q.toLowerCase() } },
            { displayName: { contains: q.q, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          workspaces: { take: 1, orderBy: { createdAt: 'asc' }, select: { id: true, plan: true } },
          _count: { select: { sessions: true } },
        },
      }),
    ]);
    const wsIds = rows.flatMap((r) => r.workspaces.map((w) => w.id));
    const month = usageMonth();
    const [usage, projects, pending, sessions] = await Promise.all([
      this.prisma.aiUsage.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: wsIds }, month },
        _sum: { chars: true },
      }),
      this.prisma.project.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: wsIds }, deletedAt: null },
        _count: true,
      }),
      this.prisma.renderJob.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: wsIds }, status: { in: ['queued', 'running'] } },
        _count: true,
      }),
      this.prisma.session.groupBy({
        by: ['userId'],
        where: { userId: { in: rows.map((r) => r.id) }, expiresAt: { gt: new Date() } },
        _count: true,
      }),
    ]);
    const u = new Map(usage.map((x) => [x.workspaceId, x._sum.chars ?? 0]));
    const p = new Map(projects.map((x) => [x.workspaceId, x._count]));
    const j = new Map(pending.map((x) => [x.workspaceId, x._count]));
    const s = new Map(sessions.map((x) => [x.userId, x._count]));
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r): AdminUserDto => {
        const w = r.workspaces[0];
        return {
          id: r.id,
          email: r.email,
          displayName: r.displayName,
          role: r.role === 'admin' ? 'admin' : 'user',
          status: r.status === 'suspended' ? 'suspended' : 'active',
          createdAt: r.createdAt.toISOString(),
          lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
          workspaceId: w?.id ?? null,
          plan: planOf(w?.plan ?? 'free'),
          aiUsedChars: w ? (u.get(w.id) ?? 0) : 0,
          projects: w ? (p.get(w.id) ?? 0) : 0,
          pendingJobs: w ? (j.get(w.id) ?? 0) : 0,
          activeSessions: s.get(r.id) ?? 0,
        };
      }),
    };
  }

  @Patch('users/:userId')
  async updateUser(
    @CurrentUser() admin: SessionUser,
    @Param('userId', UuidPipe) id: string,
    @Body(new ZodPipe(adminUserUpdateSchema)) body: z.infer<typeof adminUserUpdateSchema>,
  ) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new VoxError(ErrorCodes.NOT_FOUND, 'User not found.');
    if (id === admin.id)
      throw new VoxError(ErrorCodes.FORBIDDEN, 'You cannot change your own role or status.');
    const role = body.role ?? (target.role === 'admin' ? 'admin' : 'user');
    const status = body.status ?? (target.status === 'suspended' ? 'suspended' : 'active');
    const losesAdmin =
      target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active');
    if (losesAdmin) {
      const others = await this.prisma.user.count({
        where: { role: 'admin', status: 'active', id: { not: id } },
      });
      if (others === 0)
        throw new VoxError(
          ErrorCodes.FORBIDDEN,
          'The last active administrator cannot be demoted or suspended.',
        );
    }
    await this.prisma.user.update({ where: { id }, data: { role, status } });
    // A suspended or demoted account loses every session at once; privileges are never kept on a live cookie.
    const revoked = status !== 'active' || role !== target.role ? await this.auth.revokeSessions(id) : 0;
    await this.audit.record({
      eventType: 'admin.user_updated',
      resourceType: 'user',
      resourceId: id,
      actorUserId: admin.id,
      metadata: {
        from: { role: target.role, status: target.status },
        to: { role, status },
        revokedSessions: revoked,
      },
    });
    return { id, role, status };
  }

  @Post('users/:userId/revoke-sessions')
  @HttpCode(200)
  async revoke(@CurrentUser() admin: SessionUser, @Param('userId', UuidPipe) id: string) {
    if (!(await this.prisma.user.findUnique({ where: { id }, select: { id: true } })))
      throw new VoxError(ErrorCodes.NOT_FOUND, 'User not found.');
    const revoked = await this.auth.revokeSessions(id, id === admin.id ? admin.sessionId : undefined);
    await this.audit.record({
      eventType: 'admin.sessions_revoked',
      resourceType: 'user',
      resourceId: id,
      actorUserId: admin.id,
      metadata: { revokedSessions: revoked },
    });
    return { revoked };
  }

  // ---- audit trail -----------------------------------------------------------------------------------------
  @Get('audit')
  async auditTrail(
    @Query(new ZodPipe(adminAuditQuerySchema)) q: z.infer<typeof adminAuditQuerySchema>,
  ): Promise<AdminAuditDto[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: q.prefix ? { eventType: { startsWith: q.prefix } } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    const actors = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))] } },
      select: { id: true, email: true },
    });
    const email = new Map(actors.map((a) => [a.id, a.email]));
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      actorEmail: r.actorUserId ? (email.get(r.actorUserId) ?? null) : null,
      workspaceId: r.workspaceId,
      createdAt: r.createdAt.toISOString(),
      metadata: (r.metadataJson ?? {}) as Record<string, unknown>,
    }));
  }

  // ---- engines, voices, plans ----------------------------------------------------------------------------
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
    await this.audit.record({
      eventType: 'admin.engine_toggled',
      resourceType: 'engine',
      resourceId: id,
      actorUserId: user.id,
      metadata: { enabled: body.enabled },
    });
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
    await this.audit.record({
      eventType: 'admin.voice_toggled',
      resourceType: 'voice',
      resourceId: id,
      actorUserId: user.id,
      metadata: { enabled: body.enabled },
    });
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
      plan: planOf(w.plan),
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
    if (!(PLAN_IDS as readonly string[]).includes(body.plan))
      throw new VoxError(ErrorCodes.VALIDATION_FAILED, 'Unknown plan.');
    const w = await this.prisma.workspace.findUnique({ where: { id } });
    if (!w) throw new VoxError(ErrorCodes.NOT_FOUND, 'Workspace not found.');
    await this.prisma.workspace.update({ where: { id }, data: { plan: body.plan } });
    await this.audit.record({
      eventType: 'workspace.plan_changed',
      resourceType: 'workspace',
      resourceId: id,
      actorUserId: user.id,
      workspaceId: id,
      metadata: { from: w.plan, to: body.plan },
    });
    return { id, plan: body.plan };
  }

  /** Re-read installed voices and QA report (e.g. after running `pnpm qa:voices`). */
  @Post('catalog/refresh')
  async refresh() {
    await this.catalog.refresh();
    return this.catalog.listVoices({ admin: true });
  }
}
