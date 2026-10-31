import { Injectable } from '@nestjs/common';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { PrismaService } from './infra';
import { notFound, type SessionUser } from './http';

/**
 * Per-user authorization for every resource lookup. Resources outside the user's workspaces are
 * reported as "not found" so their existence is not revealed.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  workspace(user: SessionUser, workspaceId: string): string {
    if (!user.workspaceIds.includes(workspaceId)) throw notFound('Workspace');
    return workspaceId;
  }

  /** The user's default (first) workspace. */
  defaultWorkspace(user: SessionUser): string {
    const id = user.workspaceIds[0];
    if (!id) throw new VoxError(ErrorCodes.FORBIDDEN, 'No workspace.');
    return id;
  }

  async project(user: SessionUser, projectId: string) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null, workspaceId: { in: user.workspaceIds } },
    });
    if (!p) throw notFound('Project');
    return p;
  }

  async segment(user: SessionUser, segmentId: string) {
    const s = await this.prisma.projectSegment.findFirst({
      where: { id: segmentId, project: { deletedAt: null, workspaceId: { in: user.workspaceIds } } },
      include: { project: true },
    });
    if (!s) throw notFound('Segment');
    return s;
  }

  async job(user: SessionUser, jobId: string) {
    const j = await this.prisma.renderJob.findFirst({
      where: { id: jobId, workspaceId: { in: user.workspaceIds } },
    });
    if (!j) throw notFound('Render job');
    return j;
  }

  async asset(user: SessionUser, assetId: string) {
    const a = await this.prisma.audioAsset.findFirst({
      where: { id: assetId, workspaceId: { in: user.workspaceIds } },
    });
    if (!a) throw notFound('Asset');
    return a;
  }

  async preset(user: SessionUser, presetId: string, forWrite: boolean) {
    const p = await this.prisma.voicePreset.findFirst({
      where: { id: presetId, OR: [{ workspaceId: { in: user.workspaceIds } }, { isBuiltin: true }] },
    });
    if (!p) throw notFound('Preset');
    if (forWrite && p.isBuiltin)
      throw new VoxError(ErrorCodes.FORBIDDEN, 'Built-in presets cannot be modified; duplicate it instead.');
    return p;
  }

  async pronunciation(user: SessionUser, entryId: string) {
    const e = await this.prisma.pronunciationEntry.findFirst({
      where: { id: entryId, workspaceId: { in: user.workspaceIds } },
    });
    if (!e) throw notFound('Pronunciation entry');
    return e;
  }
}
