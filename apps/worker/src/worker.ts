import { ErrorCodes, VoxError } from '@voxstudio/contracts';
import {
  LocalStorageDriver,
  assertFfmpegCompliant,
  createEngineRegistry,
  type AppConfig,
} from '@voxstudio/core';
import { JOB_CHANNEL, notifyJob, type PrismaClient, type RenderJob } from '@voxstudio/db';
import { Client } from 'pg';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { JobExecutor } from './executor';
import { createLogger, type WorkerLogger } from './logger';
import { claimJob, extendLease, reapExpired } from './queue';
import { checkDisk, purgeOldRecords } from './disk';
import { cleanupExpiredAssets } from './retention';

export interface WorkerOptions {
  config: AppConfig;
  prisma: PrismaClient;
  logger?: WorkerLogger;
  pollMs?: number;
}

/**
 * Render worker: claims jobs from PostgreSQL, keeps leases alive, honours cancellation, and
 * records safe error codes. Startup fails if the engine or FFmpeg is missing or non-compliant.
 */
export class RenderWorker {
  readonly id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly log: WorkerLogger;
  private executor!: JobExecutor;
  private running = new Map<string, AbortController>();
  private timers: NodeJS.Timeout[] = [];
  private listener: Client | null = null;
  private stopping = false;
  private diskState: string = 'ok';
  private versions = { engines: {} as Record<string, string>, ffmpeg: '' };

  constructor(private readonly o: WorkerOptions) {
    this.log = o.logger ?? createLogger(o.config.logLevel);
  }

  async start(): Promise<void> {
    const { config, prisma } = this.o;
    const registry = createEngineRegistry(config);
    // Startup fails if any registered engine is missing or not the approved version.
    const engineVersions: Record<string, string> = {};
    for (const [id, health] of Object.entries(await registry.healthAll())) {
      if (!health.ok) {
        // An optional engine (the AI model service) may start later; jobs for it fail clearly until then.
        if (registry.get(id).optional) {
          this.log('warn', 'optional engine not available at startup', { engine: id, detail: health.detail });
          continue;
        }
        throw new Error(`Engine check failed (${id}): ${health.detail}`);
      }
      engineVersions[id] = health.version!;
    }
    await registry.initializeAll();
    const ff = await assertFfmpegCompliant(config.tools.ffmpeg);
    if (ff.flaggedFilters.length)
      this.log('info', 'ffmpeg has inert flagged filters (never invoked)', { filters: ff.flaggedFilters });
    this.versions = { engines: engineVersions, ffmpeg: ff.version };
    this.executor = new JobExecutor({
      prisma,
      registry,
      storage: new LocalStorageDriver(config.storageRoot),
      config,
      ffmpegVersion: ff.version,
      engineVersions,
      logger: this.log,
    });
    await this.heartbeat();
    await reapExpired(prisma);
    this.timers.push(setInterval(() => void this.heartbeat().catch(() => undefined), 10_000));
    this.timers.push(
      setInterval(
        () =>
          void reapExpired(prisma).catch((e) =>
            this.log('warn', 'reaper failed', { err: (e as Error).message }),
          ),
        15_000,
      ),
    );
    this.timers.push(setInterval(() => void this.fill(), this.o.pollMs ?? 2000));
    this.timers.push(
      setInterval(
        () =>
          void cleanupExpiredAssets(prisma, new LocalStorageDriver(config.storageRoot), {
            urgent: this.diskState !== 'ok',
          }).catch(() => undefined),
        10 * 60_000,
      ),
    );
    // Disk protection: measure the storage volume every minute; when it is filling up clean up faster.
    const measureDisk = async () => {
      try {
        const state = await checkDisk(prisma, config);
        if (state && state !== this.diskState) {
          this.log(state === 'ok' ? 'info' : 'warn', 'disk state changed', {
            from: this.diskState,
            to: state,
          });
          this.diskState = state;
          if (state !== 'ok')
            void cleanupExpiredAssets(prisma, new LocalStorageDriver(config.storageRoot), {
              urgent: true,
            }).catch(() => undefined);
        }
      } catch (e) {
        this.log('warn', 'disk check failed', { err: (e as Error).message });
      }
    };
    await measureDisk();
    this.timers.push(setInterval(() => void measureDisk(), 60_000));
    const purge = () =>
      void purgeOldRecords(prisma, config).catch((e) =>
        this.log('warn', 'record purge failed', { err: (e as Error).message }),
      );
    purge();
    this.timers.push(setInterval(purge, 24 * 3600_000));
    await this.listen();
    this.log('info', 'worker started', {
      workerId: this.id,
      engines: this.versions.engines,
      ffmpeg: this.versions.ffmpeg,
      concurrency: config.workerConcurrency,
    });
    void this.fill();
  }

  private async listen(): Promise<void> {
    const client = new Client({ connectionString: this.o.config.databaseUrl });
    client.on('notification', () => void this.fill());
    client.on('error', () => {
      this.listener = null;
      if (!this.stopping) setTimeout(() => void this.listen().catch(() => undefined), 2000);
    });
    await client.connect();
    await client.query(`LISTEN ${JOB_CHANNEL}`);
    this.listener = client;
  }

  /** `espeakVersion` is kept because the admin overview API reads it; `engines` is the general form. */
  private heartbeatInfo() {
    return {
      engines: this.versions.engines,
      espeakVersion: this.versions.engines.espeak ?? null,
      ffmpegVersion: this.versions.ffmpeg,
      running: this.running.size,
    };
  }

  private async heartbeat(): Promise<void> {
    const now = new Date();
    await this.o.prisma.workerHeartbeat.upsert({
      where: { workerId: this.id },
      create: {
        workerId: this.id,
        startedAt: now,
        lastSeenAt: now,
        infoJson: this.heartbeatInfo(),
      },
      update: {
        lastSeenAt: now,
        infoJson: this.heartbeatInfo(),
      },
    });
  }

  private filling = false;
  private async fill(): Promise<void> {
    if (this.stopping || this.filling) return;
    this.filling = true;
    try {
      while (!this.stopping && this.running.size < this.o.config.workerConcurrency) {
        const job = await claimJob(this.o.prisma, this.id, this.o.config.queueAgingSeconds);
        if (!job) break;
        void this.execute(job);
      }
    } catch (e) {
      this.log('warn', 'claim failed', { err: (e as Error).message });
    } finally {
      this.filling = false;
    }
  }

  private async execute(job: RenderJob): Promise<void> {
    const { prisma } = this.o;
    const ac = new AbortController();
    this.running.set(job.id, ac);
    const started = Date.now();
    this.log('info', 'job started', {
      jobId: job.id,
      kind: job.kind,
      purpose: job.purpose,
      attempt: job.attempts,
    });
    const lease = setInterval(() => {
      void extendLease(prisma, job.id, this.id)
        .then((r) => {
          if (!r || r.cancelRequested) ac.abort();
        })
        .catch(() => undefined);
    }, 5_000);
    const timeout = setTimeout(() => ac.abort(), this.o.config.renderTimeoutMs);
    try {
      const fresh = await prisma.renderJob.findUnique({ where: { id: job.id } });
      if (fresh?.cancelRequested) throw new VoxError(ErrorCodes.JOB_CANCELLED, 'The job was cancelled.');
      const r = await this.executor.run(job, ac.signal);
      await prisma.renderJob.updateMany({
        where: { id: job.id, lockedBy: this.id },
        data: {
          status: 'succeeded',
          progressUnits: job.totalUnits,
          resultAssetId: r.resultAssetId,
          warningsJson: r.warnings,
          completedAt: new Date(),
          lockedBy: null,
          lockedUntil: null,
        },
      });
      this.log('info', 'job succeeded', { jobId: job.id, ms: Date.now() - started });
    } catch (e) {
      const cancelled = (
        await prisma.renderJob.findUnique({ where: { id: job.id }, select: { cancelRequested: true } })
      )?.cancelRequested;
      let err =
        e instanceof VoxError
          ? e
          : new VoxError(
              ErrorCodes.INTERNAL_ERROR,
              'Rendering failed unexpectedly. Retry; if it persists, contact the operator.',
            );
      if (cancelled) err = new VoxError(ErrorCodes.JOB_CANCELLED, 'Cancelled by user.');
      else if (ac.signal.aborted && err.code === ErrorCodes.JOB_CANCELLED)
        err = new VoxError(ErrorCodes.SYNTHESIS_TIMEOUT, 'Rendering exceeded the time limit.');
      await prisma.renderJob.updateMany({
        where: { id: job.id, lockedBy: this.id },
        data: {
          status: err.code === ErrorCodes.JOB_CANCELLED ? 'cancelled' : 'failed',
          errorCode: err.code,
          errorMessageSafe: err.message.slice(0, 300),
          completedAt: new Date(),
          lockedBy: null,
          lockedUntil: null,
        },
      });
      await this.executor.onFailure(job, err).catch(() => undefined);
      this.log(err.code === ErrorCodes.JOB_CANCELLED ? 'info' : 'warn', 'job ended', {
        jobId: job.id,
        code: err.code,
        ...(e instanceof VoxError ? {} : { err: (e as Error)?.message?.slice(0, 200) }),
      });
    } finally {
      clearInterval(lease);
      clearTimeout(timeout);
      this.running.delete(job.id);
      await notifyJob(prisma, job.id, job.workspaceId).catch(() => undefined);
      void this.fill();
    }
  }

  get activeJobs(): number {
    return this.running.size;
  }

  /** Stop claiming; abort running jobs so their leases expire and they are re-queued. */
  async stop(opts: { abortRunning?: boolean } = {}): Promise<void> {
    this.stopping = true;
    this.timers.forEach(clearInterval);
    if (opts.abortRunning) for (const ac of this.running.values()) ac.abort();
    const deadline = Date.now() + 15_000;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await this.listener?.end().catch(() => undefined);
    await this.o.prisma.workerHeartbeat.deleteMany({ where: { workerId: this.id } }).catch(() => undefined);
  }
}
