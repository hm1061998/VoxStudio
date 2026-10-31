import { PrismaClient, Prisma } from '@prisma/client';

export { PrismaClient, Prisma };
export type * from '@prisma/client';

/** Postgres channel used to broadcast render-job changes (payload: job id + workspace id). */
export const JOB_CHANNEL = 'render_jobs';

export function createPrisma(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}

/** Notify listeners that a job changed. Payload is tiny and contains no user content. */
export async function notifyJob(
  prisma: PrismaClient | Prisma.TransactionClient,
  jobId: string,
  workspaceId: string,
): Promise<void> {
  const payload = JSON.stringify({ jobId, workspaceId });
  await prisma.$executeRaw`SELECT pg_notify(${JOB_CHANNEL}, ${payload})`;
}
