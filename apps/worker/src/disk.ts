import { classifyDisk, measureDisk, type AppConfig, type DiskState } from '@voxstudio/core';
import type { PrismaClient } from '@voxstudio/db';

/**
 * Measure the storage volume, store the result for the API and the dashboard, and write an audit event when
 * the state changes. Returns the state; a failed measurement keeps the previous state (never invents `ok`).
 */
export async function checkDisk(
  prisma: PrismaClient,
  config: AppConfig,
  measure: typeof measureDisk = measureDisk,
): Promise<DiskState | null> {
  const usage = await measure(config.storageRoot);
  const state = classifyDisk(usage, config.disk);
  const previous = await prisma.diskStatus.findUnique({ where: { id: 1 } });
  const row = {
    totalBytes: BigInt(Math.round(usage.totalBytes)),
    freeBytes: BigInt(Math.round(usage.freeBytes)),
    state,
    checkedAt: new Date(),
  };
  await prisma.diskStatus.upsert({ where: { id: 1 }, create: { id: 1, ...row }, update: row });
  if (previous?.state !== state)
    await prisma.auditEvent.create({
      data: {
        eventType: 'disk.state',
        resourceType: 'disk',
        resourceId: 'storage',
        metadataJson: {
          from: previous?.state ?? null,
          to: state,
          freePercent: Math.round((usage.freeBytes / usage.totalBytes) * 1000) / 10,
        },
      },
    });
  return state;
}

/** Delete finished render jobs and old audit events in batches (daily). Returns how many rows were removed. */
export async function purgeOldRecords(
  prisma: PrismaClient,
  config: AppConfig,
  now = Date.now(),
): Promise<{ jobs: number; audit: number }> {
  const jobCutoff = new Date(now - config.jobRetentionDays * 24 * 3600_000);
  const auditCutoff = new Date(now - config.auditRetentionDays * 24 * 3600_000);
  const jobs = await prisma.renderJob.deleteMany({
    where: { status: { in: ['succeeded', 'failed', 'cancelled'] }, completedAt: { lt: jobCutoff } },
  });
  const audit = await prisma.auditEvent.deleteMany({ where: { createdAt: { lt: auditCutoff } } });
  return { jobs: jobs.count, audit: audit.count };
}
