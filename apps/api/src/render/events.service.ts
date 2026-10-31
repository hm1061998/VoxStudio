import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { JobEventDto, JobEventType, RenderJobDto } from '@voxstudio/contracts';
import type { AppConfig } from '@voxstudio/core';
import { JOB_CHANNEL } from '@voxstudio/db';
import { Client } from 'pg';
import { Subject, type Observable, filter } from 'rxjs';
import { CONFIG, Logger, PrismaService } from '../common/infra';
import { jobDto } from '../common/mappers';

export function eventTypeFor(job: RenderJobDto): JobEventType {
  switch (job.status) {
    case 'queued':
      return 'job.queued';
    case 'running':
      return job.progressUnits === 0 ? 'job.started' : 'job.progress';
    case 'succeeded':
      return 'job.succeeded';
    case 'failed':
      return 'job.failed';
    default:
      return 'job.cancelled';
  }
}

/** Fans out Postgres NOTIFY job changes to SSE subscribers, filtered per workspace. */
@Injectable()
export class JobEventsService implements OnModuleInit, OnModuleDestroy {
  private client: Client | null = null;
  private readonly subject = new Subject<{ workspaceId: string; event: JobEventDto }>();
  private stopped = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.config.databaseUrl });
    client.on('error', (e) => {
      this.logger.warn('job listener error; reconnecting', { err: e.message });
      this.client = null;
      setTimeout(() => void this.connect().catch(() => undefined), 2000);
    });
    client.on('notification', (msg) => {
      if (msg.channel !== JOB_CHANNEL || !msg.payload) return;
      void this.handle(msg.payload);
    });
    await client.connect();
    await client.query(`LISTEN ${JOB_CHANNEL}`);
    this.client = client;
  }

  private async handle(payload: string): Promise<void> {
    try {
      const { jobId, workspaceId } = JSON.parse(payload) as { jobId: string; workspaceId: string };
      const job = await this.prisma.renderJob.findUnique({ where: { id: jobId } });
      if (!job) return;
      const asset = job.resultAssetId
        ? await this.prisma.audioAsset.findUnique({ where: { id: job.resultAssetId } })
        : null;
      const dto = jobDto(job, asset);
      this.subject.next({ workspaceId, event: { type: eventTypeFor(dto), job: dto } });
    } catch (e) {
      this.logger.warn('job event dropped', { err: (e as Error).message });
    }
  }

  stream(workspaceIds: string[]): Observable<{ workspaceId: string; event: JobEventDto }> {
    return this.subject.pipe(filter((m) => workspaceIds.includes(m.workspaceId)));
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => undefined);
  }
}
