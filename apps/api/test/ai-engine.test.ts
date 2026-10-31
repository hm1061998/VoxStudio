import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeWavPcm16 } from '@voxstudio/core';
import { claimJob } from '../../worker/dist/queue';
import { as, createHarness, register, waitForJob, type Harness, type TestUser } from './harness';

/**
 * A stand-in for the VieNeu model service that speaks the same HTTP protocol and returns a real (synthetic tone)
 * WAV. It lets the whole application path be tested without loading the 1 GB model. The real service is covered
 * by services/vieneu/test-service.mjs.
 */
const VOICES = [
  ['Ngọc Huyền', 'northern', 'female'],
  ['Hải Đăng', 'northern', 'male'],
  ['Quang Sơn', 'central', 'male'],
  ['Ngọc Trân', 'central', 'female'],
  ['Thùy Dung', 'southern', 'female'],
  ['Adam', 'southern', 'male'],
] as const;
const TOKEN = 'test-service-token';
const seen: { priority: number; chars: number; token: string | undefined; voice: string }[] = [];
let mode: 'ok' | 'busy' = 'ok';
let fake: Server;
let h: Harness;
let admin: TestUser;
let free: TestUser;
let pro: TestUser;

function tone(seconds: number): Buffer {
  const n = Math.round(seconds * 22050);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++)
    x[i] = 0.25 * Math.sin((2 * Math.PI * 180 * i) / 22050) * Math.sin((Math.PI * i) / n);
  return encodeWavPcm16(x, 22050, 1).wav;
}
const body = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => res(s));
  });

beforeAll(async () => {
  fake = createServer((req, res) => {
    void (async () => {
      if (req.url === '/v1/health') {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            ready: true,
            error: null,
            version: 'VieNeu-TTS v3 Turbo 3.8.3',
            instances: 1,
            busy: 0,
            queued: 0,
          }),
        );
      }
      const token = req.headers['x-service-token'] as string | undefined;
      if (token !== TOKEN) {
        res.statusCode = 401;
        return res.end('{}');
      }
      if (req.url === '/v1/voices') {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            model: 'VieNeu-TTS v3 Turbo 3.8.3',
            sampleRate: 22050,
            voices: VOICES.map(([id, region, gender]) => ({
              id,
              description: `· ${region}`,
              gender,
              region,
            })),
          }),
        );
      }
      if (req.url === '/v1/synthesize') {
        const j = JSON.parse(await body(req)) as { text: string; voice: string; priority: number };
        seen.push({ priority: j.priority, chars: [...j.text].length, token, voice: j.voice });
        if (mode === 'busy') {
          res.statusCode = 503;
          return res.end('{}');
        }
        res.setHeader('content-type', 'audio/wav');
        res.setHeader('x-queue-wait-ms', '5');
        return res.end(tone(Math.min(4, 0.3 + j.text.length / 20)));
      }
      res.statusCode = 404;
      res.end('{}');
    })();
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  h = await createHarness({
    ENABLED_ENGINES: 'espeak,vieneu',
    VIENEU_SERVICE_URLS: url,
    VIENEU_SERVICE_TOKEN: TOKEN,
    VIENEU_APPROVED: 'true',
    PLAN_LIMITS_JSON: JSON.stringify({ free: { aiMonthlyChars: 120 } }),
  });
  admin = await register(h, 'admin@example.test');
  free = await register(h, `free-${randomUUID().slice(0, 6)}@example.test`);
  pro = await register(h, `pro-${randomUUID().slice(0, 6)}@example.test`);
  const upgraded = await as(h, admin).patch(`/admin/workspaces/${pro.workspaceId}/plan`, { plan: 'pro' });
  expect(upgraded.status).toBe(200);
});
afterAll(async () => {
  await h?.close();
  await new Promise((r) => fake?.close(r));
});

const preview = async (u: TestUser, text: string, voiceId = 'vieneu:ngoc-huyen') => {
  const r = await as(h, u).post('/previews', { text, voiceId, locale: 'vi-VN' });
  return r;
};

describe('AI engine in the catalog', () => {
  it('lists the AI voices flagged as AI, and the rule-based voices as not AI', async () => {
    const vi = (await as(h, free).get('/voices?locale=vi')).body.data as {
      id: string;
      usesAi: boolean;
      accent: string;
      gender: string | null;
    }[];
    const ai = vi.filter((v) => v.usesAi);
    expect(ai.map((v) => v.id).sort()).toEqual(
      [
        'vieneu:adam',
        'vieneu:hai-dang',
        'vieneu:ngoc-huyen',
        'vieneu:ngoc-tran',
        'vieneu:quang-son',
        'vieneu:thuy-dung',
      ].sort(),
    );
    expect(vi.filter((v) => !v.usesAi).map((v) => v.id)).toContain('espeak:vi');
    // Every region has both a female and a male AI voice; rule-based voices state no gender.
    for (const region of ['northern', 'central', 'southern'])
      expect(new Set(ai.filter((v) => v.accent === region).map((v) => v.gender))).toEqual(
        new Set(['female', 'male']),
      );
    expect(vi.filter((v) => !v.usesAi).every((v) => v.gender === null)).toBe(true);
    expect(new Set(ai.map((v) => v.accent))).toEqual(new Set(['northern', 'central', 'southern']));
    const engines = (await as(h, free).get('/engines')).body.data as { id: string; usesAi: boolean }[];
    expect(engines.find((e) => e.id === 'vieneu')?.usesAi).toBe(true);
    expect(engines.find((e) => e.id === 'espeak')?.usesAi).toBe(false);
  });

  it('classifies its controls honestly: speed and pitch are audio processing, not engine controls', async () => {
    const p = (await as(h, free).get('/voices/vieneu:ngoc-huyen/profile')).body.data;
    expect(p.usesAi).toBe(true);
    expect(p.controls.rate).toBe('UNSUPPORTED');
    expect(p.controls.pitch).toBe('UNSUPPORTED');
    expect(p.controls.variant).toBe('UNSUPPORTED');
    expect(p.controls.tempo).toBe('DSP_DERIVED');
    expect(p.controls.pitchShiftSemitones).toBe('DSP_DERIVED');
    expect(p.inventory.kind).toBe('neural');
    expect(p.region).toBe('northern');
    expect(p.dataset).toBeNull();
  });

  it('rejects a non-default value for a control the AI engine does not have', async () => {
    const p = await as(h, free).post('/workspaces/' + free.workspaceId + '/projects', {
      name: 'x',
      defaultLocale: 'vi-VN',
      defaultVoiceId: 'vieneu:ngoc-huyen',
    });
    expect(p.status).toBe(201);
    const d = (await as(h, free).get(`/projects/${p.body.data.id}/segment-defaults`)).body.data.settings;
    const bad = await as(h, free).put(`/projects/${p.body.data.id}/segments`, {
      projectRevision: p.body.data.revision,
      segments: [
        {
          id: randomUUID(),
          sourceText: 'Xin chào.',
          locale: 'vi-VN',
          voiceId: 'vieneu:ngoc-huyen',
          settings: { ...d, rate: 1.5 },
        },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('PARAMETER_UNSUPPORTED');
  });
});

describe('AI synthesis through the application', () => {
  it('synthesizes with the AI voice, records the real engine, and forwards the plan priority', async () => {
    seen.length = 0;
    const r = await preview(free, 'Xin chào các bạn.');
    expect(r.status).toBe(201);
    const done = await waitForJob(h, free, r.body.data.id);
    expect(done.status).toBe('succeeded');
    const asset = done.resultAsset as { engines: string[]; voices: string[] };
    expect(asset.engines).toEqual(['vieneu@3.8.3']);
    expect(asset.voices).toEqual(['vieneu:ngoc-huyen']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ token: TOKEN, priority: 0, voice: 'Ngọc Huyền' });

    const r2 = await preview(pro, 'Xin chào các bạn, đây là gói trả phí.');
    const d2 = await waitForJob(h, pro, r2.body.data.id);
    expect(d2.status).toBe('succeeded');
    expect(seen.at(-1)).toMatchObject({ priority: 10 });
    const job = await h.prisma.renderJob.findUniqueOrThrow({ where: { id: r2.body.data.id } });
    expect(job.priority).toBe(10);
  });

  it('does not log or store request text in the engine record', async () => {
    const r = await preview(free, 'Câu bí mật số một.');
    const d = await waitForJob(h, free, r.body.data.id);
    const a = (await as(h, free).get(`/assets/${(d.resultAsset as { id: string }).id}`)).body.data;
    expect(JSON.stringify(a.engine)).not.toContain('bí mật');
  });

  it('meters AI characters per month, charges nothing for cache hits, and enforces the plan allowance', async () => {
    const w = await h.prisma.workspace.findUniqueOrThrow({ where: { id: free.workspaceId } });
    expect(w.plan).toBe('free');
    const before = (await as(h, free).get('/me/plan')).body.data;
    expect(before).toMatchObject({ plan: 'free', priority: 0, aiMonthlyChars: 120 });
    const text = 'Đây là một câu đủ dài để dùng một phần hạn mức.';
    const chars = [...text].length;
    const used0 = before.aiUsedChars;
    const a = await waitForJob(h, free, (await preview(free, text)).body.data.id);
    expect(a.status).toBe('succeeded');
    const mid = (await as(h, free).get('/me/plan')).body.data;
    expect(mid.aiUsedChars).toBe(used0 + chars);
    // Same text again: served from the render cache, nothing is charged, the service is not called.
    seen.length = 0;
    const again = await waitForJob(h, free, (await preview(free, text)).body.data.id);
    expect(again.status).toBe('succeeded');
    expect(seen).toHaveLength(0);
    expect((await as(h, free).get('/me/plan')).body.data.aiUsedChars).toBe(mid.aiUsedChars);
    // A long new text would pass the allowance: refused up front with a clear code, and nothing is queued.
    const long = 'Một đoạn văn rất dài sẽ vượt quá hạn mức hằng tháng của gói miễn phí. '.repeat(3);
    const refused = await preview(free, long);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(refused.body.error.details).toMatchObject({ limit: 120 });
    // The non-AI voice is unaffected by the AI allowance.
    const eSpeak = await as(h, free).post('/previews', { text: long, voiceId: 'espeak:vi', locale: 'vi-VN' });
    expect(eSpeak.status).toBe(201);
    expect((await waitForJob(h, free, eSpeak.body.data.id)).status).toBe('succeeded');
  });

  it('a busy or unreachable AI service fails the job clearly and never falls back to another engine', async () => {
    mode = 'busy';
    const r = await preview(pro, 'Câu này sẽ gặp dịch vụ đang bận.');
    const d = await waitForJob(h, pro, r.body.data.id, 60_000);
    mode = 'ok';
    expect(d.status).toBe('failed');
    expect(d.errorCode).toBe('ENGINE_BUSY');
    expect(d.resultAsset).toBeNull();
    // The application as a whole stays ready: the AI engine is optional.
    expect((await h.http().get('/api/v1/health/ready')).status).toBe(200);
  });
});

describe('plans', () => {
  it('only administrators can change a plan, and changes are audited', async () => {
    const denied = await as(h, free).patch(`/admin/workspaces/${free.workspaceId}/plan`, {
      plan: 'business',
    });
    expect(denied.status).toBe(403);
    expect(
      (await as(h, admin).patch(`/admin/workspaces/${free.workspaceId}/plan`, { plan: 'nope' })).status,
    ).toBe(400);
    const list = (await as(h, admin).get('/admin/workspaces')).body.data as {
      id: string;
      plan: string;
      aiUsedChars: number;
    }[];
    expect(list.find((w) => w.id === pro.workspaceId)?.plan).toBe('pro');
    const audit = await h.prisma.auditEvent.findMany({ where: { eventType: 'workspace.plan_changed' } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.metadataJson).toMatchObject({ from: 'free', to: 'pro' });
  });
});

describe('queue priority with aging', () => {
  it('claims higher plans first, previews before renders, and lets old jobs overtake (no starvation)', async () => {
    await h.worker.stop();
    const u = await register(h, `q-${randomUUID().slice(0, 6)}@example.test`);
    await h.prisma.renderJob.deleteMany({});
    const mk = async (label: string, priority: number, kind: string, ageSec: number) => {
      const j = await h.prisma.renderJob.create({
        data: {
          workspaceId: u.workspaceId,
          requestedByUserId: u.userId,
          kind,
          purpose: label,
          priority,
          renderPlanJson: {},
          createdAt: new Date(Date.now() - ageSec * 1000),
        },
      });
      return j.id;
    };
    const freeRender = await mk('free-render', 0, 'project', 5);
    const paidRender = await mk('paid-render', 10, 'project', 1);
    const freePreview = await mk('free-preview', 0, 'segment', 1);
    const paidPreview = await mk('paid-preview', 10, 'segment', 1);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = await claimJob(h.prisma, 'test-worker', 30);
      order.push(j!.purpose);
    }
    // paid preview (15) > paid render (10) > free preview (5) > free render (0)
    expect(order).toEqual(['paid-preview', 'paid-render', 'free-preview', 'free-render']);
    void [freeRender, paidRender, freePreview, paidPreview];

    // Aging: a free render that has waited 12 minutes (24 points at 30 s) beats a brand-new paid render (10).
    await h.prisma.renderJob.deleteMany({});
    await mk('new-paid-render', 10, 'project', 0);
    await mk('old-free-render', 0, 'project', 12 * 60);
    expect((await claimJob(h.prisma, 'test-worker', 30))!.purpose).toBe('old-free-render');
    // ...but not within the first minutes.
    await h.prisma.renderJob.deleteMany({});
    await mk('new-paid-render', 10, 'project', 0);
    await mk('young-free-render', 0, 'project', 90);
    expect((await claimJob(h.prisma, 'test-worker', 30))!.purpose).toBe('new-paid-render');
    await h.prisma.renderJob.deleteMany({});
  });
});
