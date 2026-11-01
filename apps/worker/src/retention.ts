import type { StorageDriver } from '@voxstudio/core';
import type { PrismaClient } from '@voxstudio/db';

/** Superseded segment audio and old exports are kept this long (undo, comparing, a render still running). */
export const ORPHAN_GRACE_MS = 24 * 3600_000;
const PAGE = 500;
/** When the disk is filling up: previews live 2 h and unreferenced project audio 1 h. */
export const URGENT_PREVIEW_MS = 2 * 3600_000;
export const URGENT_ORPHAN_MS = 3600_000;

/**
 * Delete assets that nothing references: expired standalone previews, and project audio/exports that are no
 * longer a segment's latest audio or a project's latest export once the grace period has passed (the old take
 * of a re-rendered segment, a replaced export). Referenced assets are never deleted.
 */
export async function cleanupExpiredAssets(
  prisma: PrismaClient,
  storage: StorageDriver,
  opts: { urgent?: boolean } = {},
): Promise<number> {
  const now = Date.now();
  const graceMs = opts.urgent ? URGENT_ORPHAN_MS : ORPHAN_GRACE_MS;
  const where = {
    OR: [
      { expiresAt: { lt: new Date(now) } },
      ...(opts.urgent ? [{ kind: 'preview', createdAt: { lt: new Date(now - URGENT_PREVIEW_MS) } }] : []),
      {
        expiresAt: null,
        kind: { in: ['segment', 'export'] },
        createdAt: { lt: new Date(now - graceMs) },
      },
    ],
  };
  let removed = 0;
  let cursor: string | undefined;
  // Page through every candidate: referenced old assets match too and must not starve the ones behind them.
  for (;;) {
    const page = await prisma.audioAsset.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      orderBy: { id: 'asc' },
      take: PAGE,
    });
    if (!page.length) break;
    cursor = page[page.length - 1]!.id;
    for (const a of page) {
      const [seg, proj] = await Promise.all([
        prisma.projectSegment.count({ where: { latestAudioAssetId: a.id } }),
        prisma.project.count({ where: { latestExportAssetId: a.id } }),
      ]);
      if (seg || proj) {
        if (a.expiresAt) await prisma.audioAsset.update({ where: { id: a.id }, data: { expiresAt: null } });
        continue;
      }
      await storage.delete(a.storageKey);
      await prisma.renderJob.updateMany({ where: { resultAssetId: a.id }, data: { resultAssetId: null } });
      await prisma.audioAsset.delete({ where: { id: a.id } });
      removed++;
    }
    if (page.length < PAGE) break;
  }
  return removed;
}
