import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import { FORMAT_INFO, type StorageDriver } from '@voxstudio/core';
import type { Response } from 'express';
import { AccessService } from '../common/access';
import { CurrentUser, RawResponse, UuidPipe, type SessionUser, type VoxRequest } from '../common/http';
import { PrismaService, STORAGE } from '../common/infra';
import { assetDto } from '../common/mappers';

/** ASCII-only, filesystem-safe filename for Content-Disposition (RFC 6266 + RFC 5987 UTF-8 variant). */
export function contentDisposition(kind: 'inline' | 'attachment', name: string, ext: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[^\w .-]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 80) || 'voxstudio';
  const utf8 = encodeURIComponent(`${name.slice(0, 80)}.${ext}`);
  return `${kind}; filename="${base}.${ext}"; filename*=UTF-8''${utf8}`;
}

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
  ) {}

  @Get(':assetId')
  async meta(@CurrentUser() user: SessionUser, @Param('assetId', UuidPipe) id: string) {
    const a = await this.access.asset(user, id);
    return {
      ...assetDto(a),
      kind: a.kind,
      projectId: a.projectId,
      segmentId: a.segmentId,
      checksumSha256: a.checksumSha256,
      engine: a.engineSnapshotJson,
      dsp: a.dspSnapshotJson,
      timeline: a.timelineJson,
    };
  }

  @Get(':assetId/stream')
  @RawResponse()
  async stream(
    @CurrentUser() user: SessionUser,
    @Param('assetId', UuidPipe) id: string,
    @Req() req: VoxRequest,
    @Res() res: Response,
  ) {
    await this.send(user, id, req, res, 'inline');
  }

  @Get(':assetId/download')
  @RawResponse()
  async download(
    @CurrentUser() user: SessionUser,
    @Param('assetId', UuidPipe) id: string,
    @Req() req: VoxRequest,
    @Res() res: Response,
  ) {
    await this.send(user, id, req, res, 'attachment');
  }

  private async send(
    user: SessionUser,
    id: string,
    req: VoxRequest,
    res: Response,
    kind: 'inline' | 'attachment',
  ): Promise<void> {
    const a = await this.access.asset(user, id);
    const size = await this.storage.size(a.storageKey);
    if (size === null)
      throw new VoxError(ErrorCodes.ASSET_MISSING, 'The audio file is no longer available. Render again.');
    const fmt = FORMAT_INFO[a.format as keyof typeof FORMAT_INFO];
    if (!fmt) throw new VoxError(ErrorCodes.ASSET_MISSING, 'Unknown asset format.');
    const project = a.projectId
      ? await this.prisma.project.findUnique({ where: { id: a.projectId }, select: { name: true } })
      : null;
    res.setHeader('Content-Type', fmt.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    // Never cache authorized audio in the browser (shared machines, sign-out).
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(kind, project?.name ?? (a.kind === 'preview' ? 'preview' : 'voxstudio'), fmt.ext),
    );
    res.setHeader('ETag', `"${a.checksumSha256}"`);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.header('range') ?? '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      this.storage.createReadStream(a.storageKey, { start, end }).pipe(res);
      return;
    }
    res.status(200);
    res.setHeader('Content-Length', String(size));
    this.storage.createReadStream(a.storageKey).pipe(res);
  }
}
