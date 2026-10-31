#!/usr/bin/env node
// Integration test for a RUNNING VieNeu model service (see README). It uses the real model and real audio.
// Usage: VIENEU_URL=http://127.0.0.1:8765 VIENEU_TOKEN=... node services/vieneu/test-service.mjs
const URL_ = (process.env.VIENEU_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const TOKEN = process.env.VIENEU_TOKEN ?? '';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const headers = { 'content-type': 'application/json', 'x-service-token': TOKEN };
const post = (body, opts = {}) =>
  fetch(`${URL_}/v1/synthesize`, {
    method: 'POST',
    headers: opts.headers ?? headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

const voices = await (await fetch(`${URL_}/v1/voices`, { headers })).json();
const voice = voices.voices[0].id;
check(
  'lists the allowlisted preset voices only',
  voices.voices.length >= 1 && voices.voices.every((v) => v.id && v.region !== undefined),
  `${voices.voices.length} voices`,
);
check(
  'no token → 401',
  (await post({ text: 'xin chào', voice }, { headers: { 'content-type': 'application/json' } })).status ===
    401,
);
check(
  'wrong token → 401',
  (await post({ text: 'xin chào', voice }, { headers: { ...headers, 'x-service-token': 'nope' } })).status ===
    401,
);
check(
  'unknown voice → 404 (no arbitrary voices)',
  (await post({ text: 'xin chào', voice: 'ai-do-khac' })).status === 404,
);
check('text over the limit → 413', (await post({ text: 'a '.repeat(5000), voice })).status === 413);
const huge = await fetch(`${URL_}/v1/synthesize`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'a'.repeat(200_000), voice }),
});
check('oversized request body → 413 before it is read', huge.status === 413, String(huge.status));
check('control characters → 400', (await post({ text: 'xin\u0000chào', voice })).status === 400);

const r = await post({ text: 'Xin chào các bạn.', voice });
const wav = Buffer.from(await r.arrayBuffer());
check('synthesis returns a WAV', r.status === 200 && wav.subarray(0, 4).toString() === 'RIFF');
check(
  'canonical format 22,050 Hz mono PCM16',
  wav.readUInt32LE(24) === 22050 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16,
);
const secs = Number(r.headers.get('x-audio-seconds'));
check('duration plausible for the text', secs > 0.8 && secs < 4, `${secs}s`);

// Priority: occupy the single instance, then queue a free request and, later, a paid one.
const busy = await (await fetch(`${URL_}/v1/health`)).json();
const long = 'Hôm nay chúng ta sẽ học một bài mới về thiên nhiên và con người. '.repeat(3);
const finished = [];
const t0 = Date.now();
const run = (label, priority, text, delay) =>
  new Promise((resolve) =>
    setTimeout(async () => {
      const x = await post({ text, voice, priority });
      await x.arrayBuffer();
      finished.push({
        label,
        status: x.status,
        at: Date.now() - t0,
        waitMs: Number(x.headers.get('x-queue-wait-ms')),
      });
      resolve();
    }, delay),
  );
await Promise.all([
  run('occupier', 0, long, 0),
  run('free', 0, 'Bạn có khỏe không?', 300),
  run('paid', 10, 'Tôi rất khỏe.', 600),
]);
const order = finished.map((f) => f.label);
if (busy.instances === 1) {
  check(
    'with one instance a later paid request overtakes an earlier free one',
    order.indexOf('paid') < order.indexOf('free'),
    order.join(' → '),
  );
} else {
  console.log(`SKIP  priority order (needs exactly 1 instance, service has ${busy.instances})`);
}
check(
  'all queued requests completed',
  finished.every((f) => f.status === 200),
);

// A client that disconnects while queued is dropped from the queue.
const ac = new AbortController();
const occupier = post({ text: long, voice });
await new Promise((r) => setTimeout(r, 200));
const dropped = post({ text: 'Câu này sẽ bị hủy.', voice }, { signal: ac.signal }).catch(() => 'aborted');
await new Promise((r) => setTimeout(r, 300));
ac.abort();
await new Promise((r) => setTimeout(r, 1500));
const mid = await (await fetch(`${URL_}/v1/health`)).json();
check(
  'a disconnected queued request leaves the queue',
  mid.queued === 0 || busy.instances > 1,
  `queued=${mid.queued}`,
);
await (await occupier).arrayBuffer();
check('request was aborted client-side', (await dropped) === 'aborted');

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
