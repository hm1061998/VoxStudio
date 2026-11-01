import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageDriver, loadConfig } from '@voxstudio/core';
import { checkDisk, purgeOldRecords } from '../../worker/dist/disk';
import { cleanupExpiredAssets } from '../../worker/dist/retention';
import { as, createHarness, register, waitForJob, type Harness, type TestUser } from './harness';

let h: Harness;
let user: TestUser;

const setDisk = (state: string, ageMs = 0) =>
  h.prisma.diskStatus.upsert({
    where: { id: 1 },
    create: { id: 1, totalBytes: 100n, freeBytes: 5n, state, checkedAt: new Date(Date.now() - ageMs) },
    update: { totalBytes: 100n, freeBytes: 5n, state, checkedAt: new Date(Date.now() - ageMs) },
  });

beforeAll(async () => {
  h = await createHarness();
  user = await register(h, `disk-${randomUUID().slice(0, 6)}@example.test`);
});
afterAll(async () => h?.close());

describe('disk protection', () => {
  it('refuses new audio jobs when the disk is critically full and recovers when it is not', async () => {
    await setDisk('block');
    const body = { text: 'Hello there.', voiceId: 'espeak:en-us', locale: 'en-US' };
    const refused = await as(h, user).post('/previews', body);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('DISK_FULL');
    // Everything else keeps working while blocked.
    expect((await as(h, user).get('/me/plan')).status).toBe(200);
    await setDisk('ok');
    const ok = await as(h, user).post('/previews', body);
    expect(ok.status).toBe(201);
    expect((await waitForJob(h, user, ok.body.data.id)).status).toBe('succeeded');
  });

  it('ignores a stale block (the API measures the real disk itself)', async () => {
    await setDisk('block', 10 * 60_000);
    const r = await as(h, user).post('/previews', {
      text: 'Fresh measurement.',
      voiceId: 'espeak:en-us',
      locale: 'en-US',
    });
    expect(r.status).toBe(201);
    await waitForJob(h, user, r.body.data.id);
  });

  it('records the measurement and writes an audit event only when the state changes', async () => {
    await h.prisma.diskStatus.deleteMany();
    await h.prisma.auditEvent.deleteMany({ where: { eventType: 'disk.state' } });
    const gb = 1024 ** 3;
    const at = (freeGb: number) => async () => ({ totalBytes: 100 * gb, freeBytes: freeGb * gb });
    expect(await checkDisk(h.prisma, h.config, at(50))).toBe('ok');
    expect(await checkDisk(h.prisma, h.config, at(49))).toBe('ok');
    expect(await checkDisk(h.prisma, h.config, at(10))).toBe('warn');
    expect(await checkDisk(h.prisma, h.config, at(2))).toBe('block');
    const events = await h.prisma.auditEvent.findMany({
      where: { eventType: 'disk.state' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => (e.metadataJson as { to: string }).to)).toEqual(['ok', 'warn', 'block']);
    const row = await h.prisma.diskStatus.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.state).toBe('block');
    await setDisk('ok');
  });

  it('cleans previews and unreferenced audio sooner in urgent mode only', async () => {
    const storage = new LocalStorageDriver(h.config.storageRoot);
    const mk = async (kind: string, ageMinutes: number, expiresInHours: number | null) => {
      const id = randomUUID();
      await h.prisma.audioAsset.create({
        data: {
          id,
          workspaceId: user.workspaceId,
          kind,
          storageKey: `${user.workspaceId}/${user.workspaceId}/${id}.wav`,
          format: 'wav',
          codec: 'pcm_s16le',
          sampleRate: 22050,
          channels: 1,
          durationMs: 1,
          fileSizeBytes: 8,
          checksumSha256: 'x',
          engineSnapshotJson: {},
          dspSnapshotJson: {},
          createdAt: new Date(Date.now() - ageMinutes * 60_000),
          expiresAt: expiresInHours === null ? null : new Date(Date.now() + expiresInHours * 3600_000),
        },
      });
      return id;
    };
    const preview3h = await mk('preview', 180, 21);
    const orphan2h = await mk('segment', 120, null);
    const fresh = await mk('segment', 10, null);
    const exists = async (id: string) => !!(await h.prisma.audioAsset.findUnique({ where: { id } }));
    await cleanupExpiredAssets(h.prisma, storage);
    expect([await exists(preview3h), await exists(orphan2h), await exists(fresh)]).toEqual([
      true,
      true,
      true,
    ]);
    await cleanupExpiredAssets(h.prisma, storage, { urgent: true });
    expect([await exists(preview3h), await exists(orphan2h), await exists(fresh)]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('purges old finished jobs and audit events but keeps recent ones', async () => {
    const old = new Date(Date.now() - 400 * 24 * 3600_000);
    await h.prisma.auditEvent.createMany({
      data: [
        { eventType: 't.old', resourceType: 't', resourceId: 'a', metadataJson: {}, createdAt: old },
        { eventType: 't.new', resourceType: 't', resourceId: 'b', metadataJson: {} },
      ],
    });
    const r = await purgeOldRecords(h.prisma, h.config);
    expect(r.audit).toBeGreaterThanOrEqual(1);
    expect(await h.prisma.auditEvent.count({ where: { eventType: 't.old' } })).toBe(0);
    expect(await h.prisma.auditEvent.count({ where: { eventType: 't.new' } })).toBe(1);
  });

  it('rejects inverted thresholds in the configuration', () => {
    expect(() =>
      loadConfig({
        ...process.env,
        DISK_WARN_FREE_PERCENT: '5',
        DISK_BLOCK_FREE_PERCENT: '10',
      }),
    ).toThrow(/DISK_BLOCK_FREE_PERCENT/);
  });
});

describe('heavy exports', () => {
  it('are refused on the free plan and allowed on pro; MP3 is never heavy', async () => {
    const created = await as(h, user).post(`/workspaces/${user.workspaceId}/projects`, {
      name: 'Heavy',
      defaultLocale: 'en-US',
      defaultVoiceId: 'espeak:en-us',
    });
    const p = created.body.data as { id: string; revision: number };
    const heavy = { format: 'wav', sampleRate: 48000, channels: 2, bitDepth: 24 };
    const refused = await as(h, user).post(`/projects/${p.id}/export`, {
      revision: p.revision,
      outputProfile: heavy,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PLAN_FEATURE_UNAVAILABLE');
    const light = await as(h, user).post(`/projects/${p.id}/export`, {
      revision: p.revision,
      outputProfile: { format: 'mp3', sampleRate: 44100, channels: 2, bitrateKbps: 192 },
    });
    expect(light.body.error?.code).not.toBe('PLAN_FEATURE_UNAVAILABLE');

    await h.prisma.workspace.update({ where: { id: user.workspaceId }, data: { plan: 'pro' } });
    const allowed = await as(h, user).post(`/projects/${p.id}/export`, {
      revision: p.revision,
      outputProfile: heavy,
    });
    expect(allowed.body.error?.code).not.toBe('PLAN_FEATURE_UNAVAILABLE');
    expect((await as(h, user).get('/me/plan')).body.data.heavyExports).toBe(true);
  });
});
