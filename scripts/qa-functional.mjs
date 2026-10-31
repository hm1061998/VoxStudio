#!/usr/bin/env node
// End-to-end functional QA against a RUNNING VoxStudio server (default http://localhost:4000).
// Flow: register → project (Vietnamese) → segments → settings → preview → render → export WAV/MP3 →
// download + validate with ffprobe → reopen → re-render (cache) → presets/dictionary/settings regression.
// Usage: node scripts/qa-functional.mjs [--base http://localhost:4000] [--out <dir>] [--json <file>]
// It writes the audio it downloads to --out so a human can listen. It does NOT judge naturalness.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import core from '../packages/core/dist/index.js';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const VOICE = arg('--voice', 'espeak:vi');
const AI = VOICE.startsWith('vieneu:');
const ENGINE = AI ? 'vieneu@' : 'espeak@';
const BASE = arg('--base', 'http://localhost:4000').replace(/\/$/, '');
const OUT = path.resolve(arg('--out', 'qa-output/functional'));
mkdirSync(OUT, { recursive: true });
const { ffprobe } = core.resolveToolPaths();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

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
  const ct = r.headers.get('content-type') ?? '';
  const json = ct.includes('json') ? await r.json() : null;
  return { status: r.status, body: json, res: r };
}
const data = (r) => r.body?.data;
async function waitJob(id, timeout = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const j = data(await call('GET', `/render-jobs/${id}`));
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job timeout');
}
const probe = (file) =>
  JSON.parse(
    execFileSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  );
async function download(assetId, name) {
  const r = await fetch(`${BASE}/api/v1/assets/${assetId}/download`, { headers: { cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  const file = path.join(OUT, name);
  writeFileSync(file, buf);
  return { status: r.status, buf, file };
}

// ---- account (throwaway, local server)
const email = `qa-${Date.now()}@example.test`;
const reg = await call('POST', '/auth/register', {
  email,
  password: `qa-${crypto.randomUUID()}`,
  displayName: 'QA',
});
check('register', reg.status === 201, reg.status);
csrf = data(reg).csrfToken;
const ws = data(reg).user.workspaces[0].id;

// ---- voices
const vi = data(await call('GET', '/voices?locale=vi'));
check(
  'Vietnamese voices offered',
  vi.some((v) => v.id === VOICE) && vi.filter((v) => v.engineId === 'espeak').length === 3,
  vi.map((v) => v.id).join(', '),
);

// ---- project
const TEXT = [
  'Xin chào các bạn. Hôm nay là ngày 31 tháng 10 năm 2026.',
  'Giá một ký gạo là 25.000 đồng, tăng 5% so với tháng trước.',
  'Bạn có khỏe không? Tôi rất khỏe, cảm ơn bạn!',
];
let p = data(
  await call('POST', `/workspaces/${ws}/projects`, {
    name: 'QA tiếng Việt',
    defaultLocale: 'vi-VN',
    defaultVoiceId: VOICE,
  }),
);
check('create project', !!p?.id);
const defaults = data(await call('GET', `/projects/${p.id}/segment-defaults`)).settings;
const segs = TEXT.map((t, i) => ({
  id: crypto.randomUUID(),
  sourceText: t,
  locale: 'vi-VN',
  voiceId: VOICE,
  // AI voices have no engine-native speed or pitch: speed is the time-stretch (audio processing) control.
  settings: AI
    ? { ...defaults, tempo: i === 1 ? 0.9 : 1, pauseAfterMs: 400 }
    : { ...defaults, rate: i === 1 ? 0.9 : 1, pitch: 55, pauseAfterMs: 400 },
}));
const saved = await call('PUT', `/projects/${p.id}/segments`, {
  projectRevision: p.revision,
  segments: segs,
});
check('save segments with settings', saved.status === 200, saved.status);
p = data(saved);

// ---- unsupported control must be rejected
const bad = await call('PUT', `/projects/${p.id}/segments`, {
  projectRevision: p.revision,
  segments: [{ ...segs[0], settings: { ...segs[0].settings, variant: 'does-not-exist' } }],
});
check('invalid setting rejected', bad.status === 400, bad.body?.error?.code);

// ---- preview
const t0 = Date.now();
const pv = data(
  await call('POST', `/segments/${segs[0].id}/preview`, {
    sourceText: segs[0].sourceText,
    voiceId: VOICE,
    locale: 'vi-VN',
    settings: segs[0].settings,
  }),
);
const pj = await waitJob(pv.id);
check('preview succeeds', pj.status === 'succeeded', `${Date.now() - t0} ms`);
const pa = await download(pj.resultAsset.id, '01-preview.wav');
check('preview audio is WAV', pa.buf.subarray(0, 4).toString() === 'RIFF' && pa.status === 200);

// ---- render
const rev = (await call('GET', `/projects/${p.id}`)).body.data.revision;
const rj = data(await call('POST', `/projects/${p.id}/render`, { revision: rev }));
const rd = await waitJob(rj.id);
check('render succeeds', rd.status === 'succeeded', rd.errorMessage ?? '');
check(
  'render reports engine and voice',
  rd.resultAsset?.engines?.[0]?.startsWith(ENGINE) && rd.resultAsset?.voices?.[0] === VOICE,
  JSON.stringify(rd.resultAsset?.engines),
);

// ---- exports
const exportOf = async (profile, file) => {
  const j = data(await call('POST', `/projects/${p.id}/export`, { revision: rev, outputProfile: profile }));
  const d = await waitJob(j.id);
  if (d.status !== 'succeeded') return { d };
  const dl = await download(d.resultAsset.id, file);
  return { d, dl, info: probe(dl.file) };
};
const wav = await exportOf({ format: 'wav', sampleRate: 22050, channels: 1, bitDepth: 16 }, '02-export.wav');
check(
  'export WAV valid',
  wav.info?.streams[0].codec_name === 'pcm_s16le' &&
    wav.dl.buf.subarray(0, 4).toString() === 'RIFF' &&
    Number(wav.info.format.duration) > 5,
  `${Number(wav.info?.format.duration).toFixed(2)} s, ${wav.dl?.buf.length} bytes`,
);
const mp3 = await exportOf(
  { format: 'mp3', sampleRate: 44100, channels: 1, bitrateKbps: 128 },
  '03-export.mp3',
);
check(
  'export MP3 valid',
  mp3.info?.streams[0].codec_name === 'mp3' && Number(mp3.info.format.duration) > 5,
  `${Number(mp3.info?.format.duration).toFixed(2)} s, ${mp3.dl?.buf.length} bytes`,
);
check(
  'WAV and MP3 durations agree (±0.2 s)',
  Math.abs(Number(wav.info?.format.duration) - Number(mp3.info?.format.duration)) < 0.2,
);

// ---- reopen + re-render
const reopened = data(await call('GET', `/projects/${p.id}`));
check(
  'reopen keeps text, voice and settings',
  reopened.segments.length === 3 &&
    reopened.segments.every((s, i) => s.sourceText === TEXT[i] && s.voiceId === VOICE) &&
    (AI ? reopened.segments[1].settings.tempo : reopened.segments[1].settings.rate) === 0.9,
);
const tr = Date.now();
const rj2 = data(await call('POST', `/projects/${p.id}/render`, { revision: reopened.revision }));
const rd2 = await waitJob(rj2.id);
const cachedNote = (rd2.warnings ?? []).some((w) => /Served from|cache/i.test(w));
check('re-render succeeds', rd2.status === 'succeeded', `${Date.now() - tr} ms, cached=${cachedNote}`);
// An export remembers its output profile for later renders (by design), so the re-render is an MP3 here.
check(
  're-render uses the remembered output profile (MP3 after MP3 export)',
  rd2.resultAsset?.format === 'mp3',
  rd2.resultAsset?.format,
);
const a2 = await download(rd2.resultAsset.id, '05-render-2.mp3');
check(
  're-render is byte-identical to the earlier export (deterministic, cached)',
  a2.buf.equals(mp3.dl.buf),
  `${a2.buf.length} vs ${mp3.dl.buf.length} bytes`,
);
const wav2 = await exportOf(
  { format: 'wav', sampleRate: 22050, channels: 1, bitDepth: 16 },
  '06-export-again.wav',
);
check(
  'second WAV export is byte-identical to the first',
  wav2.dl?.buf.equals(wav.dl.buf),
  `${wav2.dl?.buf.length} bytes`,
);

// ---- regression: presets, pronunciation, user settings
const presets = data(await call('GET', '/presets'));
check('presets listed', Array.isArray(presets) && presets.length > 0, `${presets.length}`);
const pe = await call('POST', '/pronunciation-entries', {
  locale: 'vi-VN',
  matchText: 'marketing',
  replacementText: 'mác két ting',
});
check('pronunciation entry created', pe.status === 201, pe.status);
const prev = data(
  await call('POST', '/text/normalize-preview', {
    text: 'Làm marketing.',
    locale: 'vi-VN',
    voiceId: 'espeak:vi',
  }),
);
check(
  'dictionary applied and diagnostics clean',
  prev.pronunciationApplied.length === 1 && prev.diagnostics.unreadable.length === 0,
);
const del = await call('DELETE', `/pronunciation-entries/${data(pe).id}`);
check('pronunciation entry deleted', del.status === 200 || del.status === 204, del.status);
const session = await call('GET', '/auth/session');
check('session endpoint', session.status === 200);
const list = data(await call('GET', `/workspaces/${ws}/projects`));
check(
  'project listed',
  list.some((x) => x.id === p.id),
);
const dup = await call('POST', `/projects/${p.id}/duplicate`);
check('duplicate project', dup.status === 201 || dup.status === 200, dup.status);

const failed = results.filter((r) => !r.ok);
const jsonPath = arg('--json', path.join(OUT, 'functional-results.json'));
writeFileSync(jsonPath, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Audio written to ${OUT}`);
process.exit(failed.length ? 1 : 0);
