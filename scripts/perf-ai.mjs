#!/usr/bin/env node
// Load test of the AI engine against a RUNNING stack (app + worker + model service): N free and M paid users render
// a project at the same moment. Reports when each finished, so the effect of plan priority can be seen with real
// audio generation. Plans are set directly in the database (this is a QA tool; the product uses the admin API).
// Usage: node scripts/perf-ai.mjs [--base http://localhost:4000] [--free 4] [--pro 4] [--segments 5] [--json file]
import { writeFileSync } from 'node:fs';
import core from '../packages/core/dist/index.js';
import { createPrisma } from '../packages/db/dist/index.js';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const BASE = arg('--base', 'http://localhost:4000').replace(/\/$/, '');
const FREE = Number(arg('--free', 4));
const PRO = Number(arg('--pro', 4));
const SEGMENTS = Number(arg('--segments', 5));
const VOICE = arg('--voice', 'vieneu:ngoc-huyen');
// Blockers occupy every worker slot first, so the measured jobs really have to wait in the queue (otherwise the
// first to arrive simply starts and priority has nothing to decide).
const BLOCKERS = Number(arg('--blockers', 2));
core.loadDotEnv?.(new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const prisma = createPrisma(process.env.DATABASE_URL);

class Client {
  cookie = '';
  csrf = '';
  async call(method, url, body) {
    const r = await fetch(`${BASE}/api/v1${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const j = await r.json();
    return { status: r.status, data: j.data, error: j.error };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENT = [
  'Xin chào các bạn, hôm nay chúng ta sẽ học một bài mới.',
  'Giá một ký gạo là hai mươi lăm nghìn đồng.',
  'Bạn có khỏe không? Tôi rất khỏe, cảm ơn bạn.',
  'Mùa xuân đến, cây cối đâm chồi nảy lộc.',
  'Thành phố sẽ xây thêm ba tuyến đường sắt đô thị.',
  'Cuộc sống cứ trôi như dòng sông lặng lẽ.',
];

async function makeUser(plan, i, segmentsCount = SEGMENTS, blocker = false) {
  const c = new Client();
  let reg;
  // Registration is rate limited (10 per minute per client): back off instead of failing.
  for (let attempt = 0; attempt < 12; attempt++) {
    reg = await c.call('POST', '/auth/register', {
      email: `ai-${plan}-${i}-${Date.now()}@example.test`,
      password: `ai-${crypto.randomUUID()}`,
      displayName: `${plan}${i}`,
    });
    if (reg.status !== 429) break;
    await sleep(10_000);
  }
  c.csrf = reg.data.csrfToken;
  c.ws = reg.data.user.workspaces[0].id;
  await prisma.workspace.update({ where: { id: c.ws }, data: { plan } });
  let p = (
    await c.call('POST', `/workspaces/${c.ws}/projects`, {
      name: `${plan} ${i}`,
      defaultLocale: 'vi-VN',
      defaultVoiceId: VOICE,
    })
  ).data;
  const defaults = (await c.call('GET', `/projects/${p.id}/segment-defaults`)).data.settings;
  const segments = Array.from({ length: segmentsCount }, (_, k) => ({
    id: crypto.randomUUID(),
    sourceText: `${SENT[k % SENT.length]} Số ${plan} ${i} mục ${k + 1}.`,
    locale: 'vi-VN',
    voiceId: VOICE,
    settings: defaults,
  }));
  p = (await c.call('PUT', `/projects/${p.id}/segments`, { projectRevision: p.revision, segments })).data;
  return { c, plan, i, p, blocker };
}

const blockers = [];
for (let i = 0; i < BLOCKERS; i++) blockers.push(await makeUser('free', 100 + i, SEGMENTS * 3, true));
const users = [];
for (let i = 0; i < FREE; i++) users.push(await makeUser('free', i));
for (let i = 0; i < PRO; i++) users.push(await makeUser('pro', i));

const t0 = Date.now();
const go = async (u) => {
  const r = await u.c.call('POST', `/projects/${u.p.id}/render`, { revision: u.p.revision });
  if (!r.data) throw new Error(`render refused for ${u.plan}${u.i}: ${r.status} ${JSON.stringify(r.error)}`);
  return { u, job: r.data };
};
const startedBlockers = await Promise.all(blockers.map(go));
await sleep(3000); // let the workers claim the blockers
// Then everyone else presses "render" at once, free users first in line on purpose: priority must beat arrival order.
const started = [...startedBlockers, ...(await Promise.all(users.map(go)))];
const done = await Promise.all(
  started.map(async ({ u, job }) => {
    for (;;) {
      const j = (await u.c.call('GET', `/render-jobs/${job.id}`)).data;
      if (!j) {
        await sleep(2000); // rate limited: back off
        continue;
      }
      if (['succeeded', 'failed', 'cancelled'].includes(j.status))
        return {
          blocker: u.blocker,
          plan: u.plan,
          i: u.i,
          status: j.status,
          error: j.errorCode,
          finishedAtS: Number(((Date.now() - t0) / 1000).toFixed(1)),
          queueS: Number(((new Date(j.startedAt) - new Date(j.createdAt)) / 1000).toFixed(1)),
          audioS: Number(((j.resultAsset?.durationMs ?? 0) / 1000).toFixed(1)),
        };
      await sleep(1500);
    }
  }),
);
const wall = (Date.now() - t0) / 1000;
const avg = (xs) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)) : null);
const by = (plan) => done.filter((d) => !d.blocker && d.plan === plan && d.status === 'succeeded');
const totalAudio = done.reduce((a, d) => a + d.audioS, 0);
const report = {
  at: new Date().toISOString(),
  voice: VOICE,
  config: { freeUsers: FREE, proUsers: PRO, segmentsPerProject: SEGMENTS, blockers: BLOCKERS },
  wallSeconds: Number(wall.toFixed(1)),
  totalAudioSeconds: Number(totalAudio.toFixed(1)),
  throughputAudioSecPerWallSec: Number((totalAudio / wall).toFixed(2)),
  failures: done.filter((d) => d.status !== 'succeeded').map((d) => `${d.plan}${d.i}:${d.error}`),
  free: {
    n: by('free').length,
    avgFinishS: avg(by('free').map((d) => d.finishedAtS)),
    maxFinishS: Math.max(0, ...by('free').map((d) => d.finishedAtS)),
  },
  pro: {
    n: by('pro').length,
    avgFinishS: avg(by('pro').map((d) => d.finishedAtS)),
    maxFinishS: Math.max(0, ...by('pro').map((d) => d.finishedAtS)),
  },
  jobs: done.sort((a, b) => a.finishedAtS - b.finishedAtS),
};
const out = arg('--json', null);
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
