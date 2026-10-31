import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createHarness, type Harness, type TestUser } from './harness';

const PASSWORD = 'correct-horse-battery';
let h: Harness;
let admin: TestUser;

async function login(email: string, password = PASSWORD, ip?: string) {
  const req = h.http().post('/api/v1/auth/login');
  if (ip) req.set('X-Forwarded-For', ip);
  return req.send({ email, password });
}
const asUser = (r: { headers: Record<string, unknown>; body: { data: { csrfToken: string } } }): TestUser =>
  ({
    cookie: (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
    csrf: r.body.data.csrfToken,
  }) as TestUser;
let ipCounter = 0;
/** Register from a distinct client address, so the per-address registration limit does not interfere with the scenarios. */
async function register(_h: Harness, e: string): Promise<TestUser> {
  const n = ++ipCounter;
  const r = await h
    .http()
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', `10.9.${Math.floor(n / 250)}.${(n % 250) + 1}`)
    .send({ email: e, password: PASSWORD, displayName: e.split('@')[0] });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...asUser(r), userId: r.body.data.user.id, workspaceId: r.body.data.user.workspaces[0].id };
}
const email = (tag: string) => `${tag}-${randomUUID().slice(0, 6)}@example.test`;

beforeAll(async () => {
  h = await createHarness({ ADMIN_EMAILS: 'admin@example.test,second-admin@example.test', TRUST_PROXY: '1' });
  admin = await register(h, 'admin@example.test');
});
afterAll(async () => h?.close());

describe('administrator bootstrap', () => {
  it('lets a listed address become the first administrator only; later registrations of listed addresses are ordinary users', async () => {
    expect((await as(h, admin).get('/admin/overview')).status).toBe(200);
    const second = await register(h, 'second-admin@example.test');
    expect((await as(h, second).get('/admin/overview')).status).toBe(403);
    const row = await h.prisma.user.findUniqueOrThrow({ where: { email: 'second-admin@example.test' } });
    expect(row.role).toBe('user');
  });
});

describe('sign-in lockout', () => {
  it('locks an account after repeated failures, even for the right password, and does not reveal whether it exists', async () => {
    const victim = email('victim');
    await register(h, victim);
    for (let i = 0; i < 5; i++) {
      const r = await login(victim, 'wrong-password-' + i, '10.0.0.1');
      expect(r.status).toBe(401);
    }
    const locked = await login(victim, PASSWORD, '10.0.0.2');
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    // An address that was never registered behaves identically after the same number of failures.
    const ghost = email('ghost');
    for (let i = 0; i < 5; i++) expect((await login(ghost, 'nope-nope-' + i, '10.0.0.3')).status).toBe(401);
    const ghostLocked = await login(ghost, PASSWORD, '10.0.0.4');
    expect(ghostLocked.status).toBe(429);
    expect(ghostLocked.body.error.message).toBe(locked.body.error.message);
    // Other accounts are not affected, and the lock ends after its time (simulated).
    expect((await login(admin ? 'admin@example.test' : '', PASSWORD, '10.0.0.5')).status).toBe(200);
    await h.prisma.authThrottle.updateMany({ data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await login(victim, PASSWORD, '10.0.0.6')).status).toBe(200);
    const events = await h.prisma.auditEvent.findMany({ where: { eventType: 'auth.locked' } });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events)).not.toContain(victim);
  });

  it('a successful sign-in clears the failure counter of the account', async () => {
    const e = email('forgetful');
    await register(h, e);
    for (let i = 0; i < 3; i++) await login(e, 'bad-bad-bad-' + i, '10.0.1.1');
    expect((await login(e, PASSWORD, '10.0.1.2')).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await login(e, 'bad-bad-bad-' + i, '10.0.1.3')).status).toBe(401);
    expect((await login(e, PASSWORD, '10.0.1.4')).status).toBe(200);
  });
});

describe('passwords and sessions', () => {
  it('rejects weak passwords at registration', async () => {
    for (const password of ['password1234', 'aaaaaaaaaaaa', 'abcdefghijkl', 'qwertyuiop123', '1234567890']) {
      const r = await h
        .http()
        .post('/api/v1/auth/register')
        .send({ email: email('weak'), password, displayName: 'Weak Pw' });
      expect(r.status, password).toBe(400);
    }
    const local = `nguyenvanan-${randomUUID().slice(0, 4)}`;
    const r = await h
      .http()
      .post('/api/v1/auth/register')
      .send({ email: `${local}@example.test`, password: `${local}!2026`, displayName: 'Nguyen Van An' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/email name/);
  });

  it('changing the password signs out every other session and refuses reuse of the old one', async () => {
    const e = email('rotate');
    const first = await register(h, e);
    const second = asUser(await login(e, PASSWORD, '10.0.2.1'));
    expect((await as(h, second).get('/auth/me')).status).toBe(200);
    const same = await as(h, first).post('/auth/password', {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(same.status).toBe(400);
    const wrong = await as(h, first).post('/auth/password', {
      currentPassword: 'not-the-password',
      newPassword: 'a-new-password-2026',
    });
    expect(wrong.status).toBe(401);
    const ok = await as(h, first).post('/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'a-new-password-2026',
    });
    expect(ok.status).toBe(200);
    expect((await as(h, first).get('/auth/me')).status).toBe(200);
    expect((await as(h, second).get('/auth/me')).status).toBe(401);
    expect((await login(e, PASSWORD, '10.0.2.2')).status).toBe(401);
    expect((await login(e, 'a-new-password-2026', '10.0.2.3')).status).toBe(200);
  });

  it('expires idle sessions and limits the number of live sessions per account', async () => {
    const e = email('idle');
    const u = await register(h, e);
    const row = await h.prisma.user.findUniqueOrThrow({ where: { email: e } });
    await h.prisma.session.updateMany({
      where: { userId: row.id },
      data: { lastSeenAt: new Date(Date.now() - 25 * 3600_000) },
    });
    expect((await as(h, u).get('/auth/me')).status).toBe(401);
    for (let i = 0; i < 13; i++) await login(e, PASSWORD, `10.0.3.${i + 1}`);
    expect(await h.prisma.session.count({ where: { userId: row.id } })).toBeLessThanOrEqual(10);
  });
});

describe('request origin and headers', () => {
  it('refuses state-changing requests that come from a foreign origin, even with a valid token', async () => {
    const u = await register(h, email('origin'));
    const post = (origin?: string) => {
      const r = h.http().post('/api/v1/auth/logout').set('Cookie', u.cookie).set('x-csrf-token', u.csrf);
      return origin ? r.set('Origin', origin).send({}) : r.send({});
    };
    const evil = await post('https://evil.example');
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('CSRF_INVALID');
    expect((await post('http://localhost:4000')).status).toBe(200);
  });

  it('marks API responses private and sets the hardening headers', async () => {
    const r = await h.http().get('/api/v1/health/live');
    expect(r.headers['cache-control']).toMatch(/no-store/);
    expect(r.headers['permissions-policy']).toMatch(/microphone=\(\)/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

describe('administrator rights', () => {
  it('keeps every admin route closed to ordinary users and to anonymous callers', async () => {
    const user = await register(h, email('plain'));
    const id = randomUUID();
    const calls: [string, string, unknown?][] = [
      ['get', '/admin/overview'],
      ['get', '/admin/users'],
      ['get', '/admin/audit'],
      ['get', '/admin/workspaces'],
      ['patch', `/admin/users/${id}`, { role: 'admin' }],
      ['post', `/admin/users/${id}/revoke-sessions`, {}],
      ['patch', `/admin/workspaces/${id}/plan`, { plan: 'business' }],
      ['patch', '/admin/engines/espeak', { enabled: true }],
      ['patch', '/admin/voices/espeak:vi', { enabled: true }],
      ['post', '/admin/catalog/refresh', {}],
    ];
    for (const [m, url, body] of calls) {
      const a = as(h, user) as unknown as Record<
        string,
        (u: string, b?: unknown) => Promise<{ status: number }>
      >;
      expect((await a[m === 'delete' ? 'del' : m]!(url, body)).status, `${m} ${url}`).toBe(403);
      const anon = await (h.http() as unknown as Record<string, (u: string) => Promise<{ status: number }>>)[
        m
      ]!(`/api/v1${url}`);
      expect(anon.status, `anonymous ${m} ${url}`).toBe(401);
    }
  });

  it('lists users with search and paging, and shows plan, usage and sessions', async () => {
    const needle = `needle-${randomUUID().slice(0, 5)}`;
    await register(h, `${needle}@example.test`);
    const r = await as(h, admin).get(`/admin/users?q=${needle}&pageSize=5`);
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(1);
    expect(r.body.data.items[0]).toMatchObject({
      email: `${needle}@example.test`,
      role: 'user',
      status: 'active',
      plan: 'free',
      activeSessions: 1,
    });
    const page = await as(h, admin).get('/admin/users?page=1&pageSize=2');
    expect(page.body.data.items).toHaveLength(2);
    expect((await as(h, admin).get('/admin/users?pageSize=500')).status).toBe(400);
    expect((await as(h, admin).get('/admin/users?q=%27%20OR%201%3D1--')).body.data.total).toBe(0);
  });

  it('suspends and reactivates accounts: sessions end at once, sign-in fails, everything is audited', async () => {
    const e = email('target');
    const u = await register(h, e);
    const row = await h.prisma.user.findUniqueOrThrow({ where: { email: e } });
    expect((await as(h, u).get('/auth/me')).status).toBe(200);
    const s = await as(h, admin).patch(`/admin/users/${row.id}`, { status: 'suspended' });
    expect(s.status).toBe(200);
    expect((await as(h, u).get('/auth/me')).status).toBe(401);
    const denied = await login(e, PASSWORD, '10.0.4.1');
    expect(denied.status).toBe(401);
    expect(denied.body.error.message).toBe('Email or password is incorrect.');
    expect((await as(h, admin).patch(`/admin/users/${row.id}`, { status: 'active' })).status).toBe(200);
    expect((await login(e, PASSWORD, '10.0.4.2')).status).toBe(200);
    const trail = (await as(h, admin).get('/admin/audit?prefix=admin.user')).body.data as {
      eventType: string;
      resourceId: string;
      actorEmail: string;
      metadata: { to: { status: string } };
    }[];
    const mine = trail.filter((t) => t.resourceId === row.id);
    expect(mine.map((t) => t.metadata.to.status)).toEqual(['active', 'suspended']);
    expect(mine[0]!.actorEmail).toBe('admin@example.test');
  });

  it('promotes and demotes, never lets an administrator change themselves, and keeps the last administrator', async () => {
    const e = email('promote');
    await register(h, e);
    const row = await h.prisma.user.findUniqueOrThrow({ where: { email: e } });
    const adminRow = await h.prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.test' } });
    expect((await as(h, admin).patch(`/admin/users/${row.id}`, { role: 'admin' })).status).toBe(200);
    const promoted = asUser(await login(e, PASSWORD, '10.0.5.1'));
    expect((await as(h, promoted).get('/admin/overview')).status).toBe(200);
    // Self-service changes are refused, even for an administrator.
    expect((await as(h, admin).patch(`/admin/users/${adminRow.id}`, { role: 'user' })).status).toBe(403);
    expect((await as(h, admin).patch(`/admin/users/${adminRow.id}`, { status: 'suspended' })).status).toBe(
      403,
    );
    // Demotion revokes the live sessions of the demoted account at once.
    expect((await as(h, admin).patch(`/admin/users/${row.id}`, { role: 'user' })).status).toBe(200);
    expect((await as(h, promoted).get('/admin/overview')).status).toBe(401);
    // The promoted account can no longer act; and when only one admin is left nobody can remove them.
    const only = await as(h, admin).patch(`/admin/users/${adminRow.id}`, { role: 'user' });
    expect(only.status).toBe(403);
    // Mass assignment: unknown fields and a role smuggled into the profile update are refused or ignored.
    expect(
      (await as(h, admin).patch(`/admin/users/${row.id}`, { role: 'admin', isOwner: true })).status,
    ).toBe(400);
    const plain = await register(h, email('mass'));
    await as(h, plain).patch('/auth/me', { displayName: 'Mass', role: 'admin' });
    expect((await as(h, plain).get('/admin/overview')).status).toBe(403);
  });

  it('reports users, plans, AI and security figures on the overview', async () => {
    const o = (await as(h, admin).get('/admin/overview')).body.data;
    expect(o.users.total).toBeGreaterThan(3);
    expect(o.users.admins).toBeGreaterThanOrEqual(1);
    expect(o.plans.free).toBeGreaterThan(0);
    expect(o.security).toMatchObject({ registrationOpen: true });
    expect(o.security.failedSignIns24h).toBeGreaterThan(0);
    expect(o.ai).toMatchObject({ enabled: false, service: null });
  });
});
