import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { as, createHarness, register, type Harness, type TestUser } from './harness';

// The harness loads the built API natively, so the provider class must come from that same module instance.
const BILLING_SERVICE = createRequire(import.meta.url)('../dist/billing/billing.service').BillingService;

const SECRET = 'test-webhook-secret-123456';
let h: Harness;
let admin: TestUser;
let n = 0;

beforeAll(async () => {
  h = await createHarness({
    PLAN_PRICES_VND_JSON: JSON.stringify({ pro: 100_000, business: 300_000 }),
    PAYMENT_WEBHOOK_SECRET: SECRET,
    PAYMENT_BANK_NAME: 'Test Bank',
    PAYMENT_BANK_ACCOUNT: '0123456789',
    PAYMENT_BANK_HOLDER: 'VOXSTUDIO',
  });
  admin = await register(h, 'admin@example.test');
});
afterAll(async () => h?.close());

/** Registration is limited per client address; each test user comes from its own address. */
const user = async (): Promise<TestUser> => {
  n += 1;
  const r = await h
    .http()
    .post('/api/v1/auth/register')
    .set('x-forwarded-for', `10.42.${Math.floor(n / 250)}.${(n % 250) + 1}`)
    .send({
      email: `buyer-${n}-${Date.now()}@example.test`,
      password: 'correct-horse-battery',
      displayName: 'Buyer',
    });
  if (r.status !== 201) throw new Error(`register failed: ${r.status}`);
  return {
    csrf: r.body.data.csrfToken,
    cookie: (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
    workspaceId: r.body.data.user.workspaces[0].id,
    userId: r.body.data.user.id,
  };
};
const hook = (body: unknown, token: string | null = SECRET, provider = 'generic') => {
  const r = h.http().post(`/api/v1/payments/webhook/${provider}`);
  return (token === null ? r : r.set('authorization', `Bearer ${token}`)).send(body as object);
};
const event = (note: string, amountVnd: number, eventId = `evt-${++n}-${Date.now()}`, direction = 'in') => ({
  eventId,
  direction,
  amountVnd,
  note,
});
const order = async (u: TestUser, plan = 'pro', months = 1) => {
  const r = await as(h, u).post('/billing/orders', { plan, months });
  expect(r.status).toBe(201);
  return r.body.data as { id: string; paymentCode: string; amountVnd: number };
};
const plan = async (u: TestUser) => (await as(h, u).get('/me/plan')).body.data;
const daysFromNow = (iso: string) => (new Date(iso).getTime() - Date.now()) / 86_400_000;

describe('orders', () => {
  it('shows prices and bank details, and fixes the amount when the order is created', async () => {
    const u = await user();
    const info = (await as(h, u).get('/billing/info')).body.data;
    expect(info).toMatchObject({
      enabled: true,
      prices: { pro: 100_000, business: 300_000 },
      bank: { name: 'Test Bank', account: '0123456789', holder: 'VOXSTUDIO' },
      autoConfirm: true,
    });
    const o = await order(u, 'pro', 3);
    expect(o.amountVnd).toBe(300_000);
    expect(o.paymentCode).toMatch(/^VOX[A-HJ-NP-Z2-9]{8}$/);
    const list = (await as(h, u).get('/billing/orders')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'pending', plan: 'pro', months: 3 });
  });

  it('rejects the free plan, odd durations and unknown fields, and limits unpaid orders', async () => {
    const u = await user();
    expect((await as(h, u).post('/billing/orders', { plan: 'free', months: 1 })).status).toBe(400);
    expect((await as(h, u).post('/billing/orders', { plan: 'pro', months: 2 })).status).toBe(400);
    expect((await as(h, u).post('/billing/orders', { plan: 'pro', months: 1, amountVnd: 1 })).status).toBe(
      400,
    );
    await order(u, 'pro', 1);
    await order(u, 'pro', 3);
    await order(u, 'pro', 6);
    const fourth = await as(h, u).post('/billing/orders', { plan: 'business', months: 1 });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('ORDER_STATE');
  });

  it('returns the same unpaid order for a double click, a retry or parallel requests', async () => {
    const u = await user();
    const first = await order(u, 'pro', 1);
    expect((await order(u, 'pro', 1)).id).toBe(first.id);
    const parallel = await Promise.all(
      Array.from({ length: 6 }, () => as(h, u).post('/billing/orders', { plan: 'business', months: 3 })),
    );
    expect(parallel.every((r) => r.status === 201)).toBe(true);
    expect(new Set(parallel.map((r) => r.body.data.id)).size).toBe(1);
    expect((await as(h, u).get('/billing/orders')).body.data).toHaveLength(2);
    // Once that order is paid, buying the same thing again makes a new one.
    await hook(event(first.paymentCode, 100_000));
    expect((await order(u, 'pro', 1)).id).not.toBe(first.id);
  });

  it('keeps orders private and lets the owner cancel only an unpaid one', async () => {
    const a = await user();
    const b = await user();
    const o = await order(a);
    expect((await as(h, b).get('/billing/orders')).body.data).toHaveLength(0);
    expect((await as(h, b).post(`/billing/orders/${o.id}/cancel`)).status).toBe(404);
    expect((await as(h, a).post(`/billing/orders/${o.id}/cancel`)).body.data.status).toBe('cancelled');
    expect((await as(h, a).post(`/billing/orders/${o.id}/cancel`)).status).toBe(409);
  });
});

describe('payment webhook', () => {
  it('refuses missing or wrong credentials, unknown providers and malformed bodies', async () => {
    const e = event('VOXABCDEFGH', 100_000);
    expect((await hook(e, null)).status).toBe(401);
    expect((await hook(e, 'wrong-secret-wrong-secret')).status).toBe(401);
    expect((await hook(e, SECRET, 'sepay')).status).toBe(404);
    expect((await hook({ ...e, extra: 1 })).status).toBe(400);
    expect((await hook({ ...e, amountVnd: -1 })).status).toBe(400);
  });

  it('applies the plan once for an exact payment and ignores a repeated delivery', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    const e = event(`NGUYEN VAN A chuyen khoan ${o.paymentCode.toLowerCase()}`, 100_000);
    const r = await hook(e);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, result: 'applied' });
    const p = await plan(u);
    expect(p).toMatchObject({ plan: 'pro', maxPendingJobs: 15 });
    expect(daysFromNow(p.planExpiresAt)).toBeGreaterThan(27);
    expect(daysFromNow(p.planExpiresAt)).toBeLessThan(32);
    expect((await as(h, u).get('/billing/orders')).body.data[0]).toMatchObject({
      status: 'paid',
      paidVia: 'generic',
      paidAmountVnd: 100_000,
    });
    const again = await hook(e);
    expect(again.body).toEqual({ success: true, result: 'duplicate' });
    expect((await plan(u)).planExpiresAt).toBe(p.planExpiresAt);
  });

  it('sends an underpayment to review without changing the plan; an administrator can then confirm it', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    expect((await hook(event(o.paymentCode, 50_000))).body.result).toBe('review');
    expect((await plan(u)).plan).toBe('free');
    const reviewing = (await as(h, admin).get('/admin/orders?status=review')).body.data;
    expect(reviewing.find((x: { id: string }) => x.id === o.id)).toMatchObject({ status: 'review' });
    const done = await as(h, admin).post(`/admin/orders/${o.id}/confirm`, {
      note: 'Customer paid the rest in cash',
    });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('paid');
    expect((await plan(u)).plan).toBe('pro');
  });

  it('records an unknown transfer without touching any plan, and ignores outgoing money', async () => {
    const u = await user();
    const before = (await plan(u)).plan;
    const stray = event('chuyen tien an trua', 100_000, 'stray-1');
    expect((await hook(stray)).body.result).toBe('unmatched');
    expect((await hook(event('VOXZZZZZZZZ', 100_000, 'stray-2'))).body.result).toBe('unmatched');
    expect((await hook(event('VOXZZZZZZZZ', 100_000, 'out-1', 'out'))).body.result).toBe('ignored');
    expect((await plan(u)).plan).toBe(before);
    const events = (await as(h, admin).get('/admin/payment-events')).body.data;
    expect(events.filter((x: { result: string }) => x.result === 'unmatched').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('accepts an overpayment, and money for an order that is already paid goes to review', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    expect((await hook(event(o.paymentCode, 150_000))).body.result).toBe('applied');
    expect((await as(h, u).get('/billing/orders')).body.data[0].paidAmountVnd).toBe(150_000);
    expect((await hook(event(o.paymentCode, 100_000))).body.result).toBe('review');
    expect((await plan(u)).plan).toBe('pro');
  });

  it('extends the running period for the same plan, and never replaces a different active plan silently', async () => {
    const u = await user();
    const first = await order(u, 'pro', 1);
    await hook(event(first.paymentCode, 100_000));
    const t1 = (await plan(u)).planExpiresAt;
    const second = await order(u, 'pro', 3);
    await hook(event(second.paymentCode, 300_000));
    const t2 = (await plan(u)).planExpiresAt;
    expect(daysFromNow(t2) - daysFromNow(t1)).toBeGreaterThan(88);
    expect(daysFromNow(t2) - daysFromNow(t1)).toBeLessThan(93);
    const other = await order(u, 'business', 1);
    expect((await hook(event(other.paymentCode, 300_000))).body.result).toBe('review');
    expect((await plan(u)).plan).toBe('pro');
  });

  it('applies concurrent notifications for one order only once', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    const rs = await Promise.all([
      hook(event(o.paymentCode, 100_000, 'race-a')),
      hook(event(o.paymentCode, 100_000, 'race-b')),
      hook(event(o.paymentCode, 100_000, 'race-c')),
    ]);
    const results = rs.map((r) => r.body.result).sort();
    expect(results.filter((x) => x === 'applied')).toHaveLength(1);
    expect(daysFromNow((await plan(u)).planExpiresAt)).toBeLessThan(32);
  });
});

describe('crashes and retries', () => {
  const stored = (provider: string, eventId: string, note: string, amountVnd: number, ageMs = 0) =>
    h.prisma.paymentEvent.create({
      data: {
        provider,
        eventId,
        direction: 'in',
        amountVnd,
        note,
        result: 'received',
        createdAt: new Date(Date.now() - ageMs),
      },
    });

  it('finishes a notification whose first attempt died after it was stored', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    // The state a crash leaves behind: stored, nothing applied.
    await stored('generic', 'crash-1', o.paymentCode, 100_000);
    expect((await plan(u)).plan).toBe('free');
    const retry = await hook(event(o.paymentCode, 100_000, 'crash-1'));
    expect(retry.body).toEqual({ success: true, result: 'applied' });
    expect((await plan(u)).plan).toBe('pro');
    expect((await hook(event(o.paymentCode, 100_000, 'crash-1'))).body.result).toBe('duplicate');
  });

  it('finishes stuck notifications on its own when the provider never retries', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    await stored('generic', 'crash-2', o.paymentCode, 100_000, 5 * 60_000);
    await stored('generic', 'crash-young', 'no code here', 1_000);
    const billing = h.app.get(BILLING_SERVICE, { strict: false }) as {
      reprocessStuckEvents(): Promise<number>;
    };
    expect(await billing.reprocessStuckEvents()).toBeGreaterThanOrEqual(1);
    expect((await plan(u)).plan).toBe('pro');
    // A notification only just stored may still be in flight, so it is left alone.
    const young = await h.prisma.paymentEvent.findFirst({ where: { eventId: 'crash-young' } });
    expect(young?.result).toBe('received');
    expect(await billing.reprocessStuckEvents()).toBe(0);
  });

  it('applies the plan once when the same delivery is replayed many times at once', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    const e = event(o.paymentCode, 100_000, 'replay-1');
    const rs = await Promise.all(Array.from({ length: 5 }, () => hook(e)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.result === 'applied')).toHaveLength(1);
    expect(daysFromNow((await plan(u)).planExpiresAt)).toBeLessThan(32);
  });
});

describe('resolving transfers by hand', () => {
  const pending = async (id: string) =>
    (await as(h, admin).get('/admin/payment-events')).body.data.find((x: { id: string }) => x.id === id);
  const eventIdOf = async (eventId: string) =>
    (await h.prisma.paymentEvent.findFirstOrThrow({ where: { eventId } })).id;

  it('applies a transfer with a wrong code to the order the customer meant', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    await hook(event('chuyen khoan VOXWRONGCODE', 100_000, 'typo-1'));
    const id = await eventIdOf('typo-1');
    expect((await pending(id)).result).toBe('unmatched');
    const bad = await as(h, admin).post(`/admin/payment-events/${id}/resolve`, { action: 'attach' });
    expect(bad.status).toBe(400);
    const ok = await as(h, admin).post(`/admin/payment-events/${id}/resolve`, {
      action: 'attach',
      orderId: o.id,
    });
    expect(ok.status).toBe(200);
    expect((await plan(u)).plan).toBe('pro');
    expect(await pending(id)).toBeUndefined();
    // Handled once only.
    expect(
      (await as(h, admin).post(`/admin/payment-events/${id}/resolve`, { action: 'attach', orderId: o.id }))
        .status,
    ).toBe(409);
  });

  it('adds the period again for a second payment, or dismisses it', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    await hook(event(o.paymentCode, 100_000, 'twice-1'));
    expect((await hook(event(o.paymentCode, 100_000, 'twice-2'))).body.result).toBe('review');
    const t1 = (await plan(u)).planExpiresAt;
    const id = await eventIdOf('twice-2');
    expect(
      (await as(h, admin).post(`/admin/payment-events/${id}/resolve`, { action: 'extend' })).status,
    ).toBe(200);
    const t2 = (await plan(u)).planExpiresAt;
    expect(daysFromNow(t2) - daysFromNow(t1)).toBeGreaterThan(27);
    expect(daysFromNow(t2) - daysFromNow(t1)).toBeLessThan(32);
    expect((await as(h, u).get('/billing/orders')).body.data).toHaveLength(2);

    await hook(event(o.paymentCode, 100_000, 'twice-3'));
    const id3 = await eventIdOf('twice-3');
    const dismissed = await as(h, admin).post(`/admin/payment-events/${id3}/resolve`, {
      action: 'dismiss',
      note: 'Refunded',
    });
    expect(dismissed.body.data.result).toBe('dismissed');
    expect((await plan(u)).planExpiresAt).toBe(t2);
    expect(await pending(id3)).toBeUndefined();
  });

  it('is for administrators only', async () => {
    const u = await user();
    const r = await as(h, u).post('/admin/payment-events/00000000-0000-4000-8000-000000000000/resolve', {
      action: 'dismiss',
    });
    expect(r.status).toBe(403);
  });
});

describe('plan expiry', () => {
  it('counts a lapsed paid plan as free, keeps what was stored, and the administrator sees it', async () => {
    const u = await user();
    const o = await order(u, 'pro', 1);
    await hook(event(o.paymentCode, 100_000));
    expect((await plan(u)).plan).toBe('pro');
    await h.prisma.workspace.update({
      where: { id: u.workspaceId },
      data: { planExpiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await plan(u)).toMatchObject({ plan: 'free', maxPendingJobs: 5, planExpiresAt: null });
    const ws = (await as(h, admin).get('/admin/workspaces')).body.data;
    expect(ws.find((w: { id: string }) => w.id === u.workspaceId).plan).toBe('free');
  });

  it('lets an administrator set a plan with or without an expiry', async () => {
    const u = await user();
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const r = await as(h, admin).patch(`/admin/workspaces/${u.workspaceId}/plan`, {
      plan: 'business',
      expiresAt: until,
    });
    expect(r.status).toBe(200);
    expect(await plan(u)).toMatchObject({ plan: 'business', planExpiresAt: until });
    await as(h, admin).patch(`/admin/workspaces/${u.workspaceId}/plan`, { plan: 'pro' });
    expect(await plan(u)).toMatchObject({ plan: 'pro', planExpiresAt: null });
  });

  it('keeps the order endpoints for administrators only', async () => {
    const u = await user();
    expect((await as(h, u).get('/admin/orders')).status).toBe(403);
    expect((await as(h, u).get('/admin/payment-events')).status).toBe(403);
  });
});
