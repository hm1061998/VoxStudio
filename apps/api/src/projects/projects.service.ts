import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_OUTPUT_PROFILE,
  ErrorCodes,
  VoxError,
  projectSettingsSchema,
  settingsEqual,
  synthesisSettingsSchema,
  type ErrorCode,
  type ProjectCreateInput,
  type ProjectDto,
  type ProjectSettings,
  type ProjectSummaryDto,
  type ProjectUpdateInput,
  type ProjectVersionDto,
  type SegmentAudioState,
  type SegmentDto,
  type SegmentInput,
  type SynthesisSettings,
} from '@voxstudio/contracts';
import {
  defaultSettings,
  validateSettingsForVoice,
  type AppConfig,
  type StorageDriver,
} from '@voxstudio/core';
import { Prisma, type ProjectSegment } from '@voxstudio/db';
import { randomUUID } from 'node:crypto';
import { CatalogService } from '../catalog/catalog.service';
import { AccessService } from '../common/access';
import { CONFIG, PrismaService, STORAGE } from '../common/infra';
import { assetDto } from '../common/mappers';
import type { SessionUser } from '../common/http';
import { PlannerService } from '../render/planner';

type Tx = Prisma.TransactionClient;
const ACTIVE = ['queued', 'running'];

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly catalog: CatalogService,
    private readonly planner: PlannerService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(STORAGE) private readonly storage: StorageDriver,
  ) {}

  parseSettings(json: unknown): ProjectSettings {
    const r = projectSettingsSchema.safeParse(json);
    return r.success
      ? r.data
      : { defaultVoiceId: null, defaultSettings: {}, outputProfile: DEFAULT_OUTPUT_PROFILE, joinFadeMs: 0 };
  }

  async list(
    user: SessionUser,
    workspaceId: string,
    q: { q?: string; sort: string; archived: string },
  ): Promise<ProjectSummaryDto[]> {
    this.access.workspace(user, workspaceId);
    const rows = await this.prisma.project.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        archivedAt: q.archived === 'true' ? { not: null } : null,
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy:
        q.sort === 'name'
          ? { name: 'asc' }
          : q.sort === 'created'
            ? { createdAt: 'desc' }
            : { updatedAt: 'desc' },
      include: {
        _count: { select: { segments: true } },
        jobs: { where: { kind: 'project' }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      take: 500,
    });
    const exportIds = rows.map((r) => r.latestExportAssetId).filter((x): x is string => !!x);
    const exports = new Map(
      (await this.prisma.audioAsset.findMany({ where: { id: { in: exportIds } } })).map((a) => [a.id, a]),
    );
    return rows.map((p) =>
      this.summary(
        p,
        p._count.segments,
        p.latestExportAssetId ? (exports.get(p.latestExportAssetId) ?? null) : null,
        p.jobs[0]?.status ?? null,
      ),
    );
  }

  private summary(
    p: {
      id: string;
      workspaceId: string;
      name: string;
      description: string | null;
      defaultLocale: string;
      status: string;
      revision: number;
      createdAt: Date;
      updatedAt: Date;
      archivedAt: Date | null;
    },
    segmentCount: number,
    latestExport: Parameters<typeof assetDto>[0] | null,
    lastRenderStatus: string | null,
  ): ProjectSummaryDto {
    return {
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      description: p.description,
      defaultLocale: p.defaultLocale,
      status: (p.archivedAt ? 'archived' : p.status) as ProjectSummaryDto['status'],
      revision: p.revision,
      segmentCount,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      archivedAt: p.archivedAt?.toISOString() ?? null,
      latestExport: latestExport ? assetDto(latestExport) : null,
      lastRenderStatus: (lastRenderStatus as ProjectSummaryDto['lastRenderStatus']) ?? null,
    };
  }

  async create(user: SessionUser, workspaceId: string, input: ProjectCreateInput): Promise<ProjectDto> {
    this.access.workspace(user, workspaceId);
    if (input.defaultVoiceId) await this.catalog.resolveSelectable(input.defaultVoiceId, input.defaultLocale);
    const settings: ProjectSettings = {
      defaultVoiceId: input.defaultVoiceId ?? null,
      defaultSettings: {},
      outputProfile: DEFAULT_OUTPUT_PROFILE,
      joinFadeMs: 0,
    };
    const p = await this.prisma.project.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description ?? null,
        defaultLocale: input.defaultLocale,
        settingsJson: settings,
      },
    });
    await this.audit(workspaceId, user.id, 'project.created', 'project', p.id);
    return this.get(user, p.id);
  }

  async get(user: SessionUser, projectId: string): Promise<ProjectDto> {
    const p = await this.access.project(user, projectId);
    const segments = await this.prisma.projectSegment.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
    });
    const lastJob = await this.prisma.renderJob.findFirst({
      where: { projectId, kind: 'project' },
      orderBy: { createdAt: 'desc' },
    });
    const latestExport = p.latestExportAssetId
      ? await this.prisma.audioAsset.findUnique({ where: { id: p.latestExportAssetId } })
      : null;
    return {
      ...this.summary(p, segments.length, latestExport, lastJob?.status ?? null),
      settings: this.parseSettings(p.settingsJson),
      segments: await this.segmentDtos(p.workspaceId, projectId, segments),
    };
  }

  /** Derive each segment's audio state from cache keys, active jobs and assets. */
  async segmentDtos(
    workspaceId: string,
    projectId: string,
    segments: ProjectSegment[],
  ): Promise<SegmentDto[]> {
    const rules = await this.planner.rules(workspaceId);
    const keys = await Promise.all(segments.map((s) => this.planner.currentKey(this.segmentLike(s), rules)));
    const assets = await this.prisma.audioAsset.findMany({
      where: {
        workspaceId,
        OR: [
          { id: { in: segments.map((s) => s.latestAudioAssetId).filter((x): x is string => !!x) } },
          { cacheKey: { in: keys.filter((k): k is string => !!k) }, kind: 'segment' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    const byId = new Map(assets.map((a) => [a.id, a]));
    const byKey = new Map<string, (typeof assets)[number]>();
    for (const a of assets) if (a.cacheKey && !byKey.has(a.cacheKey)) byKey.set(a.cacheKey, a);
    const active = await this.prisma.renderJob.findMany({
      where: { projectId, status: { in: ACTIVE } },
      select: { segmentId: true, kind: true, status: true },
    });
    const projectJob = active.find((j) => j.kind === 'project');
    return segments.map((s, i) => {
      const key = keys[i];
      const fresh = key ? byKey.get(key) : undefined;
      const linked = s.latestAudioAssetId ? byId.get(s.latestAudioAssetId) : undefined;
      const segJob = active.find((j) => j.segmentId === s.id);
      let state: SegmentAudioState;
      if (fresh) state = 'ready';
      else if (segJob) state = segJob.status === 'running' ? 'rendering' : 'queued';
      else if (projectJob) state = projectJob.status === 'running' ? 'rendering' : 'queued';
      else if (s.lastErrorCode) state = 'failed';
      else if (linked) state = 'stale';
      else state = 'missing';
      const audio = fresh ?? linked;
      return {
        id: s.id,
        position: s.position,
        sourceText: s.sourceText,
        locale: s.locale,
        voiceId: s.voiceId,
        settings: s.settingsJson as SynthesisSettings,
        revision: s.revision,
        audioState: state,
        audio: audio ? assetDto(audio) : null,
        lastError:
          s.lastErrorCode && !fresh
            ? { code: s.lastErrorCode as ErrorCode, message: s.lastErrorMessage ?? '' }
            : null,
      };
    });
  }

  segmentLike(s: ProjectSegment) {
    return {
      id: s.id,
      revision: s.revision,
      position: s.position,
      sourceText: s.sourceText,
      locale: s.locale,
      voiceId: s.voiceId,
      settings: s.settingsJson,
    };
  }

  /** Optimistic concurrency: lock the row, compare revision, bump it. */
  async bumpRevision(tx: Tx, projectId: string, expected: number): Promise<number> {
    const rows = await tx.$queryRaw<
      { revision: number }[]
    >`SELECT revision FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
    const current = rows[0]?.revision;
    if (current === undefined) throw new VoxError(ErrorCodes.NOT_FOUND, 'Project not found.');
    if (current !== expected)
      throw new VoxError(
        ErrorCodes.REVISION_CONFLICT,
        'This project was changed elsewhere. Reload to get the latest version.',
        { currentRevision: current },
      );
    await tx.project.update({ where: { id: projectId }, data: { revision: current + 1 } });
    return current + 1;
  }

  async update(user: SessionUser, projectId: string, input: ProjectUpdateInput): Promise<ProjectDto> {
    const p = await this.access.project(user, projectId);
    const settings = { ...this.parseSettings(p.settingsJson), ...(input.settings ?? {}) };
    if (input.settings?.defaultVoiceId) await this.catalog.resolveSelectable(input.settings.defaultVoiceId);
    await this.prisma.$transaction(async (tx) => {
      await this.bumpRevision(tx, projectId, input.revision);
      await tx.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale } : {}),
          ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
          settingsJson: projectSettingsSchema.parse(settings),
        },
      });
    });
    if (input.archived !== undefined)
      await this.audit(
        p.workspaceId,
        user.id,
        input.archived ? 'project.archived' : 'project.unarchived',
        'project',
        p.id,
      );
    return this.get(user, projectId);
  }

  async duplicate(user: SessionUser, projectId: string): Promise<ProjectDto> {
    const p = await this.access.project(user, projectId);
    const segments = await this.prisma.projectSegment.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
    });
    const copy = await this.prisma.$transaction(async (tx) => {
      const np = await tx.project.create({
        data: {
          workspaceId: p.workspaceId,
          name: `${p.name} (copy)`.slice(0, 120),
          description: p.description,
          defaultLocale: p.defaultLocale,
          settingsJson: p.settingsJson as Prisma.InputJsonValue,
        },
      });
      await tx.projectSegment.createMany({
        data: segments.map((s) => ({
          id: randomUUID(),
          projectId: np.id,
          position: s.position,
          sourceText: s.sourceText,
          locale: s.locale,
          engineId: s.engineId,
          voiceId: s.voiceId,
          settingsJson: s.settingsJson as Prisma.InputJsonValue,
        })),
      });
      return np;
    });
    await this.audit(p.workspaceId, user.id, 'project.duplicated', 'project', copy.id, { from: p.id });
    return this.get(user, copy.id);
  }

  /** Soft-delete, cancel jobs, delete stored audio, then remove metadata (never orphans objects). */
  async remove(user: SessionUser, projectId: string): Promise<void> {
    const p = await this.access.project(user, projectId);
    await this.prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
    await this.prisma.renderJob.updateMany({
      where: { projectId, status: 'queued' },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    await this.prisma.renderJob.updateMany({
      where: { projectId, status: 'running' },
      data: { cancelRequested: true },
    });
    const assets = await this.prisma.audioAsset.findMany({
      where: { projectId },
      select: { storageKey: true },
    });
    for (const a of assets) await this.storage.delete(a.storageKey);
    await this.prisma.project.delete({ where: { id: projectId } });
    await this.audit(p.workspaceId, user.id, 'project.deleted', 'project', p.id, { assets: assets.length });
  }

  // ---- segments

  private async validateSegment(s: SegmentInput): Promise<{ engineId: string }> {
    if ([...s.sourceText].length > this.config.segmentMaxChars)
      throw new VoxError(
        ErrorCodes.TEXT_TOO_LONG,
        `Segment text exceeds ${this.config.segmentMaxChars} characters.`,
      );
    const { voice, caps } = await this.catalog.resolveSelectable(s.voiceId, s.locale);
    validateSettingsForVoice(synthesisSettingsSchema.parse(s.settings), caps);
    return { engineId: voice.engineId };
  }

  /** Defaults for a new segment in this project (project default voice + preset-free defaults). */
  async newSegmentDefaults(user: SessionUser, projectId: string): Promise<SegmentInput | null> {
    const p = await this.access.project(user, projectId);
    const settings = this.parseSettings(p.settingsJson);
    const voiceId = settings.defaultVoiceId;
    if (!voiceId) return null;
    const v = this.catalog.findCatalogVoice(voiceId);
    if (!v) return null;
    const caps = this.catalog.capabilitiesFor(v);
    return {
      sourceText: '',
      locale: p.defaultLocale,
      voiceId,
      settings: { ...defaultSettings(caps), ...settings.defaultSettings } as SynthesisSettings,
    };
  }

  async createSegment(
    user: SessionUser,
    projectId: string,
    input: SegmentInput & { position?: number; projectRevision: number },
  ): Promise<ProjectDto> {
    await this.access.project(user, projectId);
    const { engineId } = await this.validateSegment(input);
    await this.prisma.$transaction(async (tx) => {
      await this.bumpRevision(tx, projectId, input.projectRevision);
      const count = await tx.projectSegment.count({ where: { projectId } });
      const position = Math.min(input.position ?? count, count);
      await this.shiftPositions(tx, projectId, position, 1);
      await tx.projectSegment.create({
        data: {
          id: randomUUID(),
          projectId,
          position,
          sourceText: input.sourceText,
          locale: input.locale,
          engineId,
          voiceId: input.voiceId,
          settingsJson: input.settings,
        },
      });
    });
    return this.get(user, projectId);
  }

  /** Move positions >= from by delta, via a negative offset to avoid unique collisions. */
  private async shiftPositions(tx: Tx, projectId: string, from: number, delta: number): Promise<void> {
    await tx.$executeRaw`UPDATE project_segments SET position = -(position + 1) WHERE project_id = ${projectId}::uuid AND position >= ${from}`;
    await tx.$executeRaw`UPDATE project_segments SET position = (-position - 1) + ${delta} WHERE project_id = ${projectId}::uuid AND position < 0`;
  }

  async updateSegment(
    user: SessionUser,
    segmentId: string,
    input: Partial<SegmentInput> & { projectRevision: number },
  ): Promise<ProjectDto> {
    const s = await this.access.segment(user, segmentId);
    const merged: SegmentInput = {
      sourceText: input.sourceText ?? s.sourceText,
      locale: input.locale ?? s.locale,
      voiceId: input.voiceId ?? s.voiceId,
      settings: input.settings ?? (s.settingsJson as SynthesisSettings),
    };
    const { engineId } = await this.validateSegment(merged);
    await this.prisma.$transaction(async (tx) => {
      await this.bumpRevision(tx, s.projectId, input.projectRevision);
      await tx.projectSegment.update({
        where: { id: segmentId },
        data: {
          sourceText: merged.sourceText,
          locale: merged.locale,
          voiceId: merged.voiceId,
          engineId,
          settingsJson: merged.settings,
          revision: { increment: 1 },
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    });
    return this.get(user, s.projectId);
  }

  async deleteSegment(user: SessionUser, segmentId: string, projectRevision: number): Promise<ProjectDto> {
    const s = await this.access.segment(user, segmentId);
    await this.prisma.$transaction(async (tx) => {
      await this.bumpRevision(tx, s.projectId, projectRevision);
      await tx.projectSegment.delete({ where: { id: segmentId } });
      await this.shiftPositions(tx, s.projectId, s.position + 1, -1);
    });
    return this.get(user, s.projectId);
  }

  async reorder(
    user: SessionUser,
    projectId: string,
    ids: string[],
    projectRevision: number,
  ): Promise<ProjectDto> {
    await this.access.project(user, projectId);
    const existing = await this.prisma.projectSegment.findMany({
      where: { projectId },
      select: { id: true },
    });
    const set = new Set(existing.map((e) => e.id));
    if (ids.length !== set.size || new Set(ids).size !== ids.length || !ids.every((id) => set.has(id)))
      throw new VoxError(
        ErrorCodes.VALIDATION_FAILED,
        'Reorder must list every segment of the project exactly once.',
      );
    await this.prisma.$transaction(async (tx) => {
      await this.bumpRevision(tx, projectId, projectRevision);
      await tx.$executeRaw`UPDATE project_segments SET position = -(position + 1) WHERE project_id = ${projectId}::uuid`;
      for (const [i, id] of ids.entries())
        await tx.projectSegment.update({ where: { id }, data: { position: i } });
    });
    return this.get(user, projectId);
  }

  /**
   * Whole-document sync used by the editor's autosave/undo/redo. Segment ids are client-generated
   * UUIDs; existing ids must belong to this project. Unchanged segments keep their revision and audio.
   */
  async sync(
    user: SessionUser,
    projectId: string,
    segments: (SegmentInput & { id: string })[],
    projectRevision: number,
  ): Promise<ProjectDto> {
    await this.access.project(user, projectId);
    if (new Set(segments.map((s) => s.id)).size !== segments.length)
      throw new VoxError(ErrorCodes.VALIDATION_FAILED, 'Duplicate segment ids.');
    const engines = new Map<string, string>();
    for (const s of segments) engines.set(s.id, (await this.validateSegment(s)).engineId);
    const foreign = await this.prisma.projectSegment.count({
      where: { id: { in: segments.map((s) => s.id) }, projectId: { not: projectId } },
    });
    if (foreign) throw new VoxError(ErrorCodes.VALIDATION_FAILED, 'Segment ids must be unique.');
    await this.prisma.$transaction(
      async (tx) => {
        await this.bumpRevision(tx, projectId, projectRevision);
        const existing = new Map(
          (await tx.projectSegment.findMany({ where: { projectId } })).map((s) => [s.id, s]),
        );
        await tx.projectSegment.deleteMany({
          where: { projectId, id: { notIn: segments.map((s) => s.id) } },
        });
        await tx.$executeRaw`UPDATE project_segments SET position = -(position + 1) WHERE project_id = ${projectId}::uuid`;
        for (const [i, s] of segments.entries()) {
          const prev = existing.get(s.id);
          const data = {
            position: i,
            sourceText: s.sourceText,
            locale: s.locale,
            voiceId: s.voiceId,
            engineId: engines.get(s.id)!,
            settingsJson: s.settings,
          };
          if (!prev) await tx.projectSegment.create({ data: { id: s.id, projectId, ...data } });
          else {
            const changed =
              prev.sourceText !== s.sourceText ||
              prev.locale !== s.locale ||
              prev.voiceId !== s.voiceId ||
              !settingsEqual(prev.settingsJson as SynthesisSettings, s.settings);
            await tx.projectSegment.update({
              where: { id: s.id },
              data: {
                ...data,
                ...(changed
                  ? { revision: { increment: 1 }, lastErrorCode: null, lastErrorMessage: null }
                  : {}),
              },
            });
          }
        }
      },
      { timeout: 30_000 },
    );
    return this.get(user, projectId);
  }

  // ---- versions

  async createVersion(user: SessionUser, projectId: string, label?: string): Promise<ProjectVersionDto> {
    const p = await this.access.project(user, projectId);
    const segments = await this.prisma.projectSegment.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
    });
    const snapshot = {
      name: p.name,
      description: p.description,
      defaultLocale: p.defaultLocale,
      settings: p.settingsJson,
      segments: segments.map((s) => ({
        id: s.id,
        sourceText: s.sourceText,
        locale: s.locale,
        voiceId: s.voiceId,
        settings: s.settingsJson,
      })),
    };
    const existing = await this.prisma.projectVersion.findUnique({
      where: { projectId_revision: { projectId, revision: p.revision } },
    });
    const v = existing
      ? await this.prisma.projectVersion.update({
          where: { id: existing.id },
          data: { label: label ?? existing.label, snapshotJson: snapshot },
        })
      : await this.prisma.projectVersion.create({
          data: {
            projectId,
            revision: p.revision,
            label: label ?? null,
            snapshotJson: snapshot,
            createdByUserId: user.id,
          },
        });
    return {
      id: v.id,
      revision: v.revision,
      label: v.label,
      createdAt: v.createdAt.toISOString(),
      segmentCount: segments.length,
    };
  }

  async listVersions(user: SessionUser, projectId: string): Promise<ProjectVersionDto[]> {
    await this.access.project(user, projectId);
    const rows = await this.prisma.projectVersion.findMany({
      where: { projectId },
      orderBy: { revision: 'desc' },
      take: 200,
    });
    return rows.map((v) => ({
      id: v.id,
      revision: v.revision,
      label: v.label,
      createdAt: v.createdAt.toISOString(),
      segmentCount: ((v.snapshotJson as { segments?: unknown[] }).segments ?? []).length,
    }));
  }

  /** Restore a snapshot as a new revision (the current state is snapshotted first). */
  async restoreVersion(
    user: SessionUser,
    projectId: string,
    versionId: string,
    projectRevision: number,
  ): Promise<ProjectDto> {
    const p = await this.access.project(user, projectId);
    const v = await this.prisma.projectVersion.findFirst({ where: { id: versionId, projectId } });
    if (!v) throw new VoxError(ErrorCodes.NOT_FOUND, 'Version not found.');
    if (p.revision !== projectRevision)
      throw new VoxError(ErrorCodes.REVISION_CONFLICT, 'This project was changed elsewhere. Reload first.', {
        currentRevision: p.revision,
      });
    await this.createVersion(user, projectId, `Before restoring revision ${v.revision}`);
    const snap = v.snapshotJson as {
      name: string;
      description: string | null;
      defaultLocale: string;
      settings: unknown;
      segments: (SegmentInput & { id: string })[];
    };
    const segs = snap.segments.map((s) => ({ ...s, settings: synthesisSettingsSchema.parse(s.settings) }));
    const updated = await this.sync(user, projectId, segs, projectRevision);
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        name: snap.name,
        description: snap.description,
        defaultLocale: snap.defaultLocale,
        settingsJson: snap.settings as Prisma.InputJsonValue,
      },
    });
    return { ...updated, name: snap.name };
  }

  async audit(
    workspaceId: string,
    actorUserId: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ) {
    await this.prisma.auditEvent.create({
      data: {
        workspaceId,
        actorUserId,
        eventType,
        resourceType,
        resourceId,
        metadataJson: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
