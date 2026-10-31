import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeWavPcm16 } from '@voxstudio/core';
import { as, createHarness, register, waitForJob, type Harness, type TestUser } from './harness';

/**
 * The product configuration: only the AI voice engine is enabled (ENABLED_ENGINES=vieneu). The model service is
 * replaced by a stand-in speaking the same protocol, so the whole application path runs without the 1 GB model.
 */
const TOKEN = 'ai-only-token';
const VOICES = [
  ['Ngọc Huyền', 'northern', 'female'],
  ['Hải Đăng', 'northern', 'male'],
  ['Adam', 'southern', 'male'],
] as const;
let up = true;
let fake: Server;
let h: Harness;
let user: TestUser;

const body = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => res(s));
  });
const tone = (sec: number) => {
  const n = Math.round(sec * 22050);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++)
    x[i] = 0.25 * Math.sin((2 * Math.PI * 200 * i) / 22050) * Math.sin((Math.PI * i) / n);
  return encodeWavPcm16(x, 22050, 1).wav;
};

beforeAll(async () => {
  fake = createServer((req, res) => {
    void (async () => {
      if (!up) {
        res.statusCode = 503;
        return res.end('{}');
      }
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
      if (req.headers['x-service-token'] !== TOKEN) {
        res.statusCode = 401;
        return res.end('{}');
      }
      if (req.url === '/v1/voices') {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            model: 'VieNeu-TTS v3 Turbo 3.8.3',
            sampleRate: 22050,
            voices: VOICES.map(([id, region, gender]) => ({ id, description: region, gender, region })),
          }),
        );
      }
      if (req.url === '/v1/synthesize') {
        const j = JSON.parse(await body(req)) as { text: string };
        res.setHeader('content-type', 'audio/wav');
        return res.end(tone(Math.min(4, 0.3 + j.text.length / 20)));
      }
      res.statusCode = 404;
      res.end('{}');
    })();
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  h = await createHarness({
    ENABLED_ENGINES: 'vieneu',
    VIENEU_SERVICE_URLS: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
    VIENEU_SERVICE_TOKEN: TOKEN,
    VIENEU_APPROVED: 'true',
  });
  user = await register(h, 'ai-only-user@example.test');
});
afterAll(async () => {
  await h?.close();
  await new Promise((r) => fake?.close(r));
});

describe('AI-only deployment (the product default)', () => {
  it('offers only the AI voices, Vietnamese only, and no rule-based voice', async () => {
    const all = (await as(h, user).get('/voices')).body.data as {
      id: string;
      engineId: string;
      locale: string;
      usesAi: boolean;
    }[];
    expect(all.length).toBe(3);
    expect(new Set(all.map((v) => v.engineId))).toEqual(new Set(['vieneu']));
    expect(new Set(all.map((v) => v.locale))).toEqual(new Set(['vi-VN']));
    expect(all.every((v) => v.usesAi)).toBe(true);
    expect((await as(h, user).get('/voices?locale=en')).body.data).toEqual([]);
    const engines = (await as(h, user).get('/engines')).body.data as { id: string }[];
    expect(engines.map((e) => e.id)).toEqual(['vieneu']);
  });

  it('refuses a rule-based voice everywhere: profile, preview and project', async () => {
    expect((await as(h, user).get('/voices/espeak:vi/profile')).status).toBe(404);
    const pv = await as(h, user).post('/previews', {
      text: 'Xin chào.',
      voiceId: 'espeak:vi',
      locale: 'vi-VN',
    });
    expect(pv.status).toBeGreaterThanOrEqual(400);
    expect(pv.body.error.code).toBe('VOICE_NOT_AVAILABLE');
    const p = await as(h, user).post(`/workspaces/${user.workspaceId}/projects`, {
      name: 'x',
      defaultLocale: 'vi-VN',
      defaultVoiceId: 'espeak:vi',
    });
    expect(p.status).toBeGreaterThanOrEqual(400);
  });

  it('speaks with an AI voice end to end and records the engine', async () => {
    const r = await as(h, user).post('/previews', {
      text: 'Xin chào các bạn.',
      voiceId: 'vieneu:adam',
      locale: 'vi-VN',
    });
    expect(r.status).toBe(201);
    const done = await waitForJob(h, user, r.body.data.id);
    expect(done.status).toBe('succeeded');
    expect((done.resultAsset as { engines: string[] }).engines).toEqual(['vieneu@3.8.3']);
  });

  it('is not ready when the model service is down (nothing can speak), and recovers without a restart', async () => {
    expect((await h.http().get('/api/v1/health/ready')).status).toBe(200);
    up = false;
    const down = await h.http().get('/api/v1/health/ready');
    expect(down.status).toBe(503);
    const fail = await as(h, user).post('/previews', {
      text: 'Câu khi dịch vụ tắt.',
      voiceId: 'vieneu:adam',
      locale: 'vi-VN',
    });
    const job = await waitForJob(h, user, fail.body.data.id, 60_000);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('ENGINE_UNAVAILABLE');
    up = true;
    expect((await h.http().get('/api/v1/health/ready')).status).toBe(200);
  });
});
