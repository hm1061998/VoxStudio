import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createHarness, register, type Harness, type TestUser } from './harness';

let h: Harness;
let u: TestUser;

beforeAll(async () => {
  h = await createHarness();
  u = await register(h, 'no-billing@example.test');
});
afterAll(async () => h?.close());

describe('billing is off unless prices are configured', () => {
  it('reports it, refuses orders, and has no webhook', async () => {
    expect((await as(h, u).get('/billing/info')).body.data).toMatchObject({
      enabled: false,
      prices: {},
      autoConfirm: false,
    });
    const r = await as(h, u).post('/billing/orders', { plan: 'pro', months: 1 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('BILLING_DISABLED');
    const hook = await h
      .http()
      .post('/api/v1/payments/webhook/generic')
      .set('authorization', 'Bearer anything-at-all-123456')
      .send({ eventId: 'x', direction: 'in', amountVnd: 1000, note: 'VOXABCDEFGH' });
    expect(hook.status).toBe(404);
  });
});
