import type { StorageDriver } from '@voxstudio/core';
import type { PrismaClient } from '@voxstudio/db';

/**
 * Delete expired assets (standalone previews) that nothing references. Assets referenced as a
 * segment's latest audio or a project's latest export are never deleted.
 */
export async function cleanupExpiredAssets(prisma: PrismaClient, storage: StorageDriver): Promise<number> {
  const expired = await prisma.audioAsset.findMany({ where: { expiresAt: { lt: new Date() } }, take: 500 });
  let removed = 0;
  for (const a of expired) {
    const [seg, proj] = await Promise.all([
      prisma.projectSegment.count({ where: { latestAudioAssetId: a.id } }),
      prisma.project.count({ where: { latestExportAssetId: a.id } }),
    ]);
    if (seg || proj) {
      await prisma.audioAsset.update({ where: { id: a.id }, data: { expiresAt: null } });
      continue;
    }
    await storage.delete(a.storageKey);
    await prisma.renderJob.updateMany({ where: { resultAssetId: a.id }, data: { resultAssetId: null } });
    await prisma.audioAsset.delete({ where: { id: a.id } });
    removed++;
  }
  return removed;
}
