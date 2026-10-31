import { ErrorCodes } from '@voxstudio/contracts';
import { notifyJob, type PrismaClient, type RenderJob } from '@voxstudio/db';

export const LEASE_MS = 60_000;

/** Interactive single-segment jobs (previews) get this many extra points over project renders of the same plan. */
export const INTERACTIVE_BOOST = 5;

/**
 * Atomically claim the queued job with the highest score; concurrent workers never claim the same job.
 * score = plan priority + one point per `agingSeconds` waited + INTERACTIVE_BOOST for single-segment jobs.
 * A paid plan therefore goes first, a preview goes before a long render of the same plan, and a job that has
 * waited long enough overtakes newer jobs of a higher plan (no starvation). Ties: oldest first.
 */
export async function claimJob(
  prisma: PrismaClient,
  workerId: string,
  agingSeconds = 30,
): Promise<RenderJob | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE render_jobs SET status = 'running', locked_by = ${workerId},
      locked_until = now() + make_interval(secs => ${LEASE_MS / 1000}),
      attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now()
    WHERE id = (
      SELECT id FROM render_jobs WHERE status = 'queued'
      ORDER BY (priority
                + floor(extract(epoch FROM (now() - created_at)) / ${agingSeconds})::int
                + CASE WHEN kind = 'segment' THEN ${INTERACTIVE_BOOST} ELSE 0 END) DESC,
               created_at ASC
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id`;
  const id = rows[0]?.id;
  if (!id) return null;
  const job = await prisma.renderJob.findUniqueOrThrow({ where: { id } });
  await notifyJob(prisma, job.id, job.workspaceId);
  return job;
}

export async function extendLease(
  prisma: PrismaClient,
  jobId: string,
  workerId: string,
): Promise<{ cancelRequested: boolean } | null> {
  const rows = await prisma.$queryRaw<{ cancel_requested: boolean }[]>`
    UPDATE render_jobs SET locked_until = now() + make_interval(secs => ${LEASE_MS / 1000})
    WHERE id = ${jobId}::uuid AND locked_by = ${workerId} AND status = 'running'
    RETURNING cancel_requested`;
  const r = rows[0];
  return r ? { cancelRequested: r.cancel_requested } : null;
}

/**
 * Jobs whose lease expired (worker crashed or was restarted) are re-queued until max attempts,
 * then failed. Assets are content-addressed by cache key, so a re-run never duplicates outputs.
 */
export async function reapExpired(prisma: PrismaClient): Promise<number> {
  const expired = await prisma.renderJob.findMany({
    where: { status: 'running', lockedUntil: { lt: new Date() } },
  });
  for (const j of expired) {
    const giveUp = j.attempts >= j.maxAttempts;
    const r = await prisma.renderJob.updateMany({
      where: { id: j.id, status: 'running', lockedUntil: { lt: new Date() } },
      data: giveUp
        ? {
            status: 'failed',
            errorCode: ErrorCodes.WORKER_LOST,
            errorMessageSafe: 'The render worker stopped repeatedly while processing this job. Retry later.',
            completedAt: new Date(),
            lockedBy: null,
          }
        : { status: 'queued', lockedBy: null, lockedUntil: null, progressUnits: 0 },
    });
    if (r.count) {
      if (giveUp && j.kind === 'project' && j.projectId) await restoreProjectStatus(prisma, j.projectId);
      await notifyJob(prisma, j.id, j.workspaceId);
    }
  }
  return expired.length;
}

/** After a failed/cancelled render the previous export (if any) stays current. */
export async function restoreProjectStatus(prisma: PrismaClient, projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({ where: { id: projectId } });
  if (!p) return;
  const active = await prisma.renderJob.count({
    where: { projectId, kind: 'project', status: { in: ['queued', 'running'] } },
  });
  if (!active)
    await prisma.project.update({
      where: { id: projectId },
      data: { status: p.latestExportAssetId ? 'rendered' : 'draft' },
    });
}
