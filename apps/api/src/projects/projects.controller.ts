import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  projectCreateSchema,
  projectListQuerySchema,
  projectUpdateSchema,
  segmentCreateSchema,
  segmentReorderSchema,
  segmentsSyncSchema,
  segmentUpdateSchema,
  versionCreateSchema,
  workspaceUpdateSchema,
} from '@voxstudio/contracts';
import { z } from 'zod';
import { AccessService } from '../common/access';
import { CurrentUser, UuidPipe, ZodPipe, type SessionUser } from '../common/http';
import { PrismaService } from '../common/infra';
import { ProjectsService } from './projects.service';

const revisionBody = z.strictObject({ projectRevision: z.number().int().min(0) });

@Controller()
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  // ---- workspaces (single-owner workspaces in the initial release)
  @Get('workspaces')
  async workspaces(@CurrentUser() user: SessionUser) {
    const rows = await this.prisma.workspace.findMany({
      where: { id: { in: user.workspaceIds } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    }));
  }

  @Get('workspaces/:workspaceId')
  async workspace(@CurrentUser() user: SessionUser, @Param('workspaceId', UuidPipe) id: string) {
    this.access.workspace(user, id);
    const w = await this.prisma.workspace.findUniqueOrThrow({ where: { id } });
    return {
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  @Patch('workspaces/:workspaceId')
  async renameWorkspace(
    @CurrentUser() user: SessionUser,
    @Param('workspaceId', UuidPipe) id: string,
    @Body(new ZodPipe(workspaceUpdateSchema)) body: z.infer<typeof workspaceUpdateSchema>,
  ) {
    this.access.workspace(user, id);
    const w = await this.prisma.workspace.update({ where: { id }, data: { name: body.name } });
    return {
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  // ---- projects
  @Get('workspaces/:workspaceId/projects')
  list(
    @CurrentUser() user: SessionUser,
    @Param('workspaceId', UuidPipe) ws: string,
    @Query(new ZodPipe(projectListQuerySchema)) q: z.infer<typeof projectListQuerySchema>,
  ) {
    return this.projects.list(user, ws, q);
  }

  @Post('workspaces/:workspaceId/projects')
  create(
    @CurrentUser() user: SessionUser,
    @Param('workspaceId', UuidPipe) ws: string,
    @Body(new ZodPipe(projectCreateSchema)) body: z.infer<typeof projectCreateSchema>,
  ) {
    return this.projects.create(user, ws, body);
  }

  @Get('projects/:projectId')
  get(@CurrentUser() user: SessionUser, @Param('projectId', UuidPipe) id: string) {
    return this.projects.get(user, id);
  }

  @Patch('projects/:projectId')
  update(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Body(new ZodPipe(projectUpdateSchema)) body: z.infer<typeof projectUpdateSchema>,
  ) {
    return this.projects.update(user, id, body);
  }

  @Delete('projects/:projectId')
  async remove(@CurrentUser() user: SessionUser, @Param('projectId', UuidPipe) id: string) {
    await this.projects.remove(user, id);
    return { deleted: true };
  }

  @Post('projects/:projectId/duplicate')
  duplicate(@CurrentUser() user: SessionUser, @Param('projectId', UuidPipe) id: string) {
    return this.projects.duplicate(user, id);
  }

  @Get('projects/:projectId/segment-defaults')
  defaults(@CurrentUser() user: SessionUser, @Param('projectId', UuidPipe) id: string) {
    return this.projects.newSegmentDefaults(user, id);
  }

  // ---- versions
  @Post('projects/:projectId/versions')
  createVersion(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Body(new ZodPipe(versionCreateSchema)) body: z.infer<typeof versionCreateSchema>,
  ) {
    return this.projects.createVersion(user, id, body.label);
  }

  @Get('projects/:projectId/versions')
  versions(@CurrentUser() user: SessionUser, @Param('projectId', UuidPipe) id: string) {
    return this.projects.listVersions(user, id);
  }

  @Post('projects/:projectId/versions/:versionId/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Param('versionId', UuidPipe) versionId: string,
    @Body(new ZodPipe(revisionBody)) body: z.infer<typeof revisionBody>,
  ) {
    return this.projects.restoreVersion(user, id, versionId, body.projectRevision);
  }

  // ---- segments
  @Post('projects/:projectId/segments')
  createSegment(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Body(new ZodPipe(segmentCreateSchema)) body: z.infer<typeof segmentCreateSchema>,
  ) {
    return this.projects.createSegment(user, id, body);
  }

  @Put('projects/:projectId/segments')
  sync(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Body(new ZodPipe(segmentsSyncSchema)) body: z.infer<typeof segmentsSyncSchema>,
  ) {
    return this.projects.sync(user, id, body.segments, body.projectRevision);
  }

  @Post('projects/:projectId/segments/reorder')
  @HttpCode(200)
  reorder(
    @CurrentUser() user: SessionUser,
    @Param('projectId', UuidPipe) id: string,
    @Body(new ZodPipe(segmentReorderSchema)) body: z.infer<typeof segmentReorderSchema>,
  ) {
    return this.projects.reorder(user, id, body.segmentIds, body.projectRevision);
  }

  @Patch('segments/:segmentId')
  updateSegment(
    @CurrentUser() user: SessionUser,
    @Param('segmentId', UuidPipe) id: string,
    @Body(new ZodPipe(segmentUpdateSchema)) body: z.infer<typeof segmentUpdateSchema>,
  ) {
    return this.projects.updateSegment(user, id, body);
  }

  @Delete('segments/:segmentId')
  deleteSegment(
    @CurrentUser() user: SessionUser,
    @Param('segmentId', UuidPipe) id: string,
    @Query('projectRevision') rev: string,
  ) {
    const r = z.coerce.number().int().min(0).parse(rev);
    return this.projects.deleteSegment(user, id, r);
  }
}
