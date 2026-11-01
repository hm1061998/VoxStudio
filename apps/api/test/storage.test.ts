import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetStorageKey, LocalStorageDriver } from '@voxstudio/core';
import { cleanupExpiredAssets } from '../../worker/dist/retention';
import { as, createHarness, register, waitForJob, type Harness, type TestUser } from './harness';

let h: Harness;
let user: TestUser;

beforeAll(async () => {
  // A tiny allowance so one preview exhausts it.
  h = await createHarness({ PLAN_LIMITS_JSON: JSON.stringify({ free: { storageBytes: 1000 } }) });
  user = await register(h, 'storage-user@example.test');
});
afterAll(async () => {
  await h?.close();
});

describe('stored audio allowance and cleanup', () => {
  it('refuses new audio once the plan allowance is used, and reports usage', async () => {
    const first = await as(h, user).post('/previews', {
      text: 'Hello there.',
      voiceId: 'espeak:en-us',
      locale: 'en-US',
    });
    expect(first.status).toBe(201);
    expect((await waitForJob(h, user, first.body.data.id)).status).toBe('succeeded');
    const plan = (await as(h, user).get('/me/plan')).body.data;
    expect(plan.storageBytes).toBe(1000);
    expect(plan.storageUsedBytes).toBeGreaterThan(1000);
    const second = await as(h, user).post('/previews', {
      text: 'Another sentence.',
      voiceId: 'espeak:en-us',
      locale: 'en-US',
    });
    expect(second.status).toBe(402);
    expect(second.body.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
  });

  it('deletes unreferenced project audio after the grace period and keeps referenced audio', async () => {
    const storage = new LocalStorageDriver(h.config.storageRoot);
    const mk = async (referenced: boolean, ageHours: number) => {
      const id = randomUUID();
      const key = assetStorageKey(user.workspaceId, user.workspaceId, id, 'wav');
      await storage.putBuffer(key, Buffer.from('RIFFxxxx'));
      await h.prisma.audioAsset.create({
        data: {
          id,
          workspaceId: user.workspaceId,
          kind: 'segment',
          storageKey: key,
          format: 'wav',
          codec: 'pcm_s16le',
          sampleRate: 22050,
          channels: 1,
          durationMs: 1,
          fileSizeBytes: 8,
          checksumSha256: 'x',
          engineSnapshotJson: {},
          dspSnapshotJson: {},
          createdAt: new Date(Date.now() - ageHours * 3600_000),
        },
      });
      return { id, key, referenced };
    };
    const orphanOld = await mk(false, 48);
    const orphanNew = await mk(false, 1);
    const kept = await mk(true, 48);
    const project = (
      await as(h, user).post(`/workspaces/${user.workspaceId}/projects`, {
        name: 'keep',
        defaultLocale: 'en-US',
        defaultVoiceId: 'espeak:en-us',
      })
    ).body.data;
    await h.prisma.project.update({ where: { id: project.id }, data: { latestExportAssetId: kept.id } });

    await cleanupExpiredAssets(h.prisma, storage);

    const exists = async (a: { id: string; key: string }) => ({
      row: !!(await h.prisma.audioAsset.findUnique({ where: { id: a.id } })),
      file: existsSync(path.join(h.config.storageRoot, a.key)),
    });
    expect(await exists(orphanOld)).toEqual({ row: false, file: false });
    expect(await exists(orphanNew)).toEqual({ row: true, file: true });
    expect(await exists(kept)).toEqual({ row: true, file: true });
  });
});
