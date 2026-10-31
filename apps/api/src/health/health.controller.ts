import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { HealthDto } from '@voxstudio/contracts';
import type { StorageDriver } from '@voxstudio/core';
import type { Response } from 'express';
import { Public } from '../auth/guards';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService, STORAGE } from '../common/infra';
import { RawResponse } from '../common/http';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
  ) {}

  @Get('live')
  @RawResponse()
  live(): HealthDto {
    return { status: 'ok', checks: { process: { ok: true } } };
  }

  /** Readiness: database, storage, approved engine, compliant FFmpeg, and a live worker. */
  @Get('ready')
  @RawResponse()
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthDto> {
    const checks: HealthDto['checks'] = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch {
      checks.database = { ok: false, detail: 'database unreachable' };
    }
    checks.storage = (await this.storage.healthCheck())
      ? { ok: true }
      : { ok: false, detail: 'storage not writable' };
    const engine = await this.catalog.engineHealth();
    checks.engine = { ok: engine.ok, detail: engine.detail };
    const ff = this.catalog.ffmpegInfo;
    checks.ffmpeg = ff
      ? ff.prohibitedFilters.length
        ? { ok: false, detail: `prohibited filters: ${ff.prohibitedFilters.join(',')}` }
        : { ok: true, detail: ff.version }
      : { ok: false, detail: 'ffmpeg unavailable' };
    try {
      const hb = await this.prisma.workerHeartbeat.findFirst({ orderBy: { lastSeenAt: 'desc' } });
      const fresh = !!hb && Date.now() - hb.lastSeenAt.getTime() < 60_000;
      checks.worker = fresh
        ? { ok: true }
        : { ok: false, detail: hb ? 'no recent worker heartbeat' : 'no worker has started' };
    } catch {
      checks.worker = { ok: false, detail: 'unknown' };
    }
    const critical = ['database', 'storage', 'engine', 'ffmpeg'].every((k) => checks[k]?.ok);
    const status: HealthDto['status'] = critical ? (checks.worker?.ok ? 'ok' : 'degraded') : 'fail';
    res.status(critical ? 200 : 503);
    return { status, checks };
  }
}
