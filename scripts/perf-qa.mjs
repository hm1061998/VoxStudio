#!/usr/bin/env node
// Performance QA against a RUNNING server: synthesis time, real-time factor, queue latency, cache
// effectiveness, concurrent jobs, and CPU / memory of the node, eSpeak and FFmpeg processes (Windows).
// Usage: node scripts/perf-qa.mjs [--base http://localhost:4000] [--projects 6] [--segments 8] [--json file]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const BASE = arg('--base', 'http://localhost:4000').replace(/\/$/, '');
const PROJECTS = Number(arg('--projects', 6));
const SEGMENTS = Number(arg('--segments', 8));
let cookie = '';
let csrf = '';
async function call(method, url, body) {
  const r = await fetch(`${BASE}/api/v1${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, data: (await r.json()).data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJob(id) {
  for (;;) {
    const j = (await call('GET', `/render-jobs/${id}`)).data;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await sleep(50);
  }
}
const stats = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
  return { n: v.length, min: v[0], p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
};

// ---- process sampling (Windows PowerShell)
function snapshot() {
  const ps =
    "Get-Process | Where-Object { $_.Name -match '^(node|espeak-ng|ffmpeg|ffprobe|postgres)$' } | Select-Object Name,Id,WorkingSet64,CPU | ConvertTo-Json -Compress";
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    const j = out ? JSON.parse(out) : [];
    return Array.isArray(j) ? j : [j];
  } catch {
    return [];
  }
}
function startSampler() {
  const samples = [];
  const base = new Map(snapshot().map((p) => [p.Id, p.CPU ?? 0]));
  const t0 = Date.now();
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const now = snapshot();
      samples.push({
        t: Date.now() - t0,
        rssMb: now.reduce((a, p) => a + p.WorkingSet64, 0) / 1048576,
        byName: Object.fromEntries(
          [...new Set(now.map((p) => p.Name))].map((n) => [
            n,
            now.filter((p) => p.Name === n).reduce((a, p) => a + p.WorkingSet64, 0) / 1048576,
          ]),
        ),
        cpu: new Map(now.map((p) => [p.Id, p.CPU ?? 0])),
        procs: now.filter((p) => /espeak|ffmpeg/.test(p.Name)).length,
      });
      await sleep(300);
    }
  })();
  return async () => {
    stop = true;
    await loop;
    const wall = (Date.now() - t0) / 1000;
    const last = new Map();
    for (const s of samples) for (const [id, c] of s.cpu) last.set(id, c);
    let cpuSec = 0;
    for (const [id, c] of last) cpuSec += c - (base.get(id) ?? 0);
    const peakByName = {};
    for (const s of samples)
      for (const [n, mb] of Object.entries(s.byName)) peakByName[n] = Math.max(peakByName[n] ?? 0, mb);
    return {
      wallSec: Number(wall.toFixed(2)),
      cpuSecObservedProcesses: Number(cpuSec.toFixed(2)),
      avgCoresBusy: Number((cpuSec / wall).toFixed(2)),
      peakTotalRssMb: Math.round(Math.max(...samples.map((s) => s.rssMb))),
      peakRssMbByProcessName: Object.fromEntries(
        Object.entries(peakByName).map(([n, v]) => [n, Math.round(v)]),
      ),
      peakConcurrentEngineProcesses: Math.max(0, ...samples.map((s) => s.procs)),
      note: 'CPU is only counted for processes alive at a sample, so short-lived eSpeak/FFmpeg children are under-counted.',
    };
  };
}

const reg = await call('POST', '/auth/register', {
  email: `perf-${Date.now()}@example.test`,
  password: `perf-${crypto.randomUUID()}`,
  displayName: 'Perf',
});
csrf = reg.data.csrfToken;
const ws = reg.data.user.workspaces[0].id;
const VOICE = ((await call('GET', '/voices?locale=vi')).data ?? [])[0]?.id ?? 'none:none';

const SENT = [
  'Xin chào các bạn, hôm nay chúng ta sẽ học một bài mới về thiên nhiên và con người.',
  'Giá một ký gạo là hai mươi lăm nghìn đồng, tăng năm phần trăm so với tháng trước.',
  'Bạn có khỏe không? Tôi rất khỏe, cảm ơn bạn đã hỏi thăm.',
  'Mùa xuân đến, cây cối đâm chồi nảy lộc, hoa nở khắp nơi trên các con đường.',
  'Thành phố sẽ đầu tư xây dựng thêm ba tuyến đường sắt đô thị trong những năm tới.',
  'Để nấu món canh chua cá, trước tiên bạn cần sơ chế cá thật sạch sẽ.',
  'Cuộc sống cứ trôi như dòng sông lặng lẽ chảy qua những mùa đông và mùa hạ.',
  'Kính thưa quý khách, chuyến bay đi Đà Nẵng sẽ khởi hành lúc tám giờ mười lăm.',
];
async function makeProject(tag, count) {
  let p = (
    await call('POST', `/workspaces/${ws}/projects`, {
      name: `perf ${tag}`,
      defaultLocale: 'vi-VN',
      defaultVoiceId: VOICE,
    })
  ).data;
  const defaults = (await call('GET', `/projects/${p.id}/segment-defaults`)).data.settings;
  // Unique text per project so nothing is served from another project's cache.
  const segments = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    sourceText: `${SENT[i % SENT.length]} Mã ${tag} số ${i + 1}.`,
    locale: 'vi-VN',
    voiceId: VOICE,
    settings: defaults,
  }));
  p = (await call('PUT', `/projects/${p.id}/segments`, { projectRevision: p.revision, segments })).data;
  return { p, segments, defaults };
}
const timing = (j) => ({
  queueMs: new Date(j.startedAt) - new Date(j.createdAt),
  runMs: new Date(j.completedAt) - new Date(j.startedAt),
  audioMs: j.resultAsset?.durationMs ?? 0,
});

const report = {
  at: new Date().toISOString(),
  host: {
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0].model,
    ramGb: Math.round(os.totalmem() / 1e9),
    os: `${os.type()} ${os.release()}`,
  },
  config: { projects: PROJECTS, segmentsPerProject: SEGMENTS },
};

// 1. Single cold render, then a fully cached re-render, then one edited segment.
{
  const { p, segments, defaults } = await makeProject('single', SEGMENTS);
  const stop = startSampler();
  const j1 = await waitJob(
    (await call('POST', `/projects/${p.id}/render`, { revision: p.revision })).data.id,
  );
  const cold = timing(j1);
  const j2 = await waitJob(
    (await call('POST', `/projects/${p.id}/render`, { revision: p.revision })).data.id,
  );
  const warm = timing(j2);
  const edited = segments.map((s, i) =>
    i === 0 ? { ...s, sourceText: `${s.sourceText} Thêm một câu.` } : s,
  );
  const p2 = (
    await call('PUT', `/projects/${p.id}/segments`, { projectRevision: p.revision, segments: edited })
  ).data;
  const j3 = await waitJob(
    (await call('POST', `/projects/${p.id}/render`, { revision: p2.revision })).data.id,
  );
  const part = timing(j3);
  report.single = {
    segments: SEGMENTS,
    cold: {
      ...cold,
      rtf: Number((cold.runMs / cold.audioMs).toFixed(3)),
      perSegmentMs: Math.round(cold.runMs / SEGMENTS),
    },
    cachedRerender: {
      ...warm,
      speedupVsCold: Number((cold.runMs / Math.max(1, warm.runMs)).toFixed(1)),
      warnings: j2.warnings,
    },
    oneSegmentEdited: {
      ...part,
      rtf: Number((part.runMs / part.audioMs).toFixed(3)),
      vsCold: Number((part.runMs / cold.runMs).toFixed(2)),
    },
    resources: await stop(),
  };
  void defaults;
}

// 2. Concurrent projects.
{
  const made = [];
  for (let i = 0; i < PROJECTS; i++) made.push(await makeProject(`c${i}`, SEGMENTS));
  const stop = startSampler();
  const t0 = Date.now();
  const jobs = await Promise.all(
    made.map(
      async ({ p }) => (await call('POST', `/projects/${p.id}/render`, { revision: p.revision })).data,
    ),
  );
  const done = await Promise.all(jobs.map((j) => waitJob(j.id)));
  const wallMs = Date.now() - t0;
  const ok = done.filter((j) => j.status === 'succeeded');
  const tm = ok.map(timing);
  const audioMs = tm.reduce((a, t) => a + t.audioMs, 0);
  report.concurrent = {
    jobs: PROJECTS,
    succeeded: ok.length,
    failed: done.length - ok.length,
    wallMs,
    totalAudioMs: audioMs,
    aggregateRtf: Number((wallMs / audioMs).toFixed(3)),
    queueLatencyMs: stats(tm.map((t) => t.queueMs)),
    runMs: stats(tm.map((t) => t.runMs)),
    resources: await stop(),
  };
}

// 3. Interactive preview latency (what the user waits for when pressing Listen).
{
  const { p, segments, defaults } = await makeProject('prev', 1);
  const lat = [];
  for (let i = 0; i < 12; i++) {
    const t0 = Date.now();
    const j = await waitJob(
      (
        await call('POST', `/segments/${segments[0].id}/preview`, {
          sourceText: `${SENT[i % SENT.length]} Lần ${i} ${Date.now()}.`,
          voiceId: VOICE,
          locale: 'vi-VN',
          settings: defaults,
        })
      ).data.id,
    );
    if (j.status === 'succeeded') lat.push(Date.now() - t0);
  }
  report.previewLatencyMs = stats(lat);
  void p;
}

const path = arg('--json', null);
if (path) writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
