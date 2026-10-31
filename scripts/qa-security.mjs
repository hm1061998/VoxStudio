#!/usr/bin/env node
// Black-box security probe against a RUNNING server. Not a penetration test: it checks the controls the
// application claims (authentication, CSRF, per-user isolation, input limits, headers, cookie flags).
// Usage: node scripts/qa-security.mjs [--base http://localhost:4000]
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const BASE = arg('--base', 'http://localhost:4000').replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
async function raw(method, url, { cookie, csrf, body, headers } = {}) {
  return fetch(`${BASE}/api/v1${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function account(tag) {
  const r = await raw('POST', '/auth/register', {
    body: {
      email: `sec-${tag}-${Date.now()}@example.test`,
      password: `sec-${crypto.randomUUID()}`,
      displayName: tag,
    },
  });
  const j = await r.json();
  return {
    status: r.status,
    cookie: r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
    setCookie: r.headers.getSetCookie(),
    csrf: j.data.csrfToken,
    ws: j.data.user.workspaces[0].id,
    headers: r.headers,
  };
}

const a = await account('a');
const b = await account('b');

// Authentication
check(
  'unauthenticated request is rejected',
  (await raw('GET', '/projects/00000000-0000-4000-8000-000000000000')).status === 401,
);
check('unauthenticated voices list is rejected', (await raw('GET', '/voices')).status === 401);

// Cookie flags
const sess = a.setCookie.find((c) => /session|sid/i.test(c)) ?? a.setCookie[0] ?? '';
check(
  'session cookie is HttpOnly and SameSite',
  /HttpOnly/i.test(sess) && /SameSite=(Lax|Strict)/i.test(sess),
  sess.replace(/=[^;]+/, '=…'),
);

// CSRF
const noCsrf = await raw('POST', `/workspaces/${a.ws}/projects`, {
  cookie: a.cookie,
  body: { name: 'x', defaultLocale: 'vi-VN', defaultVoiceId: 'espeak:vi' },
});
check('state-changing request without CSRF token is rejected', noCsrf.status === 403, noCsrf.status);
const badCsrf = await raw('POST', `/workspaces/${a.ws}/projects`, {
  cookie: a.cookie,
  csrf: 'wrong',
  body: { name: 'x', defaultLocale: 'vi-VN', defaultVoiceId: 'espeak:vi' },
});
check('wrong CSRF token is rejected', badCsrf.status === 403, badCsrf.status);

// Isolation between users
const proj = (
  await (
    await raw('POST', `/workspaces/${a.ws}/projects`, {
      cookie: a.cookie,
      csrf: a.csrf,
      body: { name: 'private', defaultLocale: 'vi-VN', defaultVoiceId: 'espeak:vi' },
    })
  ).json()
).data;
check(
  'owner can read own project',
  (await raw('GET', `/projects/${proj.id}`, { cookie: a.cookie })).status === 200,
);
check(
  'another user gets 404 for the project',
  (await raw('GET', `/projects/${proj.id}`, { cookie: b.cookie })).status === 404,
);
check(
  'another user cannot create in the first user workspace',
  [403, 404].includes(
    (
      await raw('POST', `/workspaces/${a.ws}/projects`, {
        cookie: b.cookie,
        csrf: b.csrf,
        body: { name: 'intrusion', defaultLocale: 'vi-VN', defaultVoiceId: 'espeak:vi' },
      })
    ).status,
  ),
);
check(
  'admin endpoints refuse a normal user',
  (await raw('GET', '/admin/overview', { cookie: a.cookie })).status === 403,
);

// Input handling
check(
  'malformed JSON is a 4xx, not a crash',
  (await raw('POST', '/text/split', { cookie: a.cookie, csrf: a.csrf, body: '{bad json' })).status < 500,
);
check(
  'unknown fields are rejected (strict schemas)',
  (
    await raw('POST', '/text/split', {
      cookie: a.cookie,
      csrf: a.csrf,
      body: { text: 'a', mode: 'sentence', locale: 'vi-VN', evil: 1 },
    })
  ).status === 400,
);
check(
  'invalid asset id is rejected without touching storage',
  [400, 404].includes((await raw('GET', '/assets/..%2F..%2F.env/download', { cookie: a.cookie })).status),
);
const big = await raw('POST', '/text/split', {
  cookie: a.cookie,
  csrf: a.csrf,
  body: { text: 'x'.repeat(5_000_000), mode: 'sentence', locale: 'vi-VN' },
});
check('oversized body is refused', [400, 413].includes(big.status), big.status);
const sqli = await raw(
  'GET',
  `/workspaces/${a.ws}/projects?q=${encodeURIComponent("' OR 1=1; DROP TABLE users;--")}`,
  { cookie: a.cookie },
);
check('search input is treated as data', sqli.status === 200 && (await sqli.json()).data.length === 0);
const longPrev = await raw('POST', '/previews', {
  cookie: a.cookie,
  csrf: a.csrf,
  body: { text: 'a'.repeat(5000), voiceId: 'espeak:vi', locale: 'vi-VN' },
});
check('preview text over the limit is refused', [400, 413].includes(longPrev.status), longPrev.status);
const ctl = await raw('POST', '/previews', {
  cookie: a.cookie,
  csrf: a.csrf,
  body: { text: 'xin chào; $(calc) `id` | & ../../etc', voiceId: 'espeak:vi', locale: 'vi-VN' },
});
check(
  'shell metacharacters in text are accepted as plain text',
  ctl.status === 202 || ctl.status === 201 || ctl.status === 200,
  ctl.status,
);

// Headers
const h = (await raw('GET', '/health/live')).headers;
const web = await fetch(`${BASE}/`);
const wh = web.headers;
check(
  'X-Content-Type-Options: nosniff',
  (h.get('x-content-type-options') ?? wh.get('x-content-type-options')) === 'nosniff',
);
check('no X-Powered-By header', !h.get('x-powered-by') && !wh.get('x-powered-by'));
check(
  'clickjacking protection (frame-ancestors or X-Frame-Options)',
  /frame-ancestors|DENY|SAMEORIGIN/i.test(
    `${wh.get('content-security-policy') ?? ''} ${wh.get('x-frame-options') ?? ''}`,
  ),
);
check('Content-Security-Policy present on the web client', !!wh.get('content-security-policy'));
const cors = await fetch(`${BASE}/api/v1/health/live`, { headers: { origin: 'https://evil.example' } });
check('foreign origin is not granted CORS access', !cors.headers.get('access-control-allow-origin'));
const err = await raw('GET', '/projects/not-a-uuid', { cookie: a.cookie });
const errText = await err.text();
check(
  'error responses do not leak stack traces or paths',
  !/\bat .*\.(js|ts):\d+|node_modules|D:\\|C:\\/.test(errText),
  errText.slice(0, 100),
);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
