import { describe, expect, it } from 'vitest';
import {
  addMonths,
  effectivePlan,
  extractPaymentCode,
  generatePaymentCode,
  genericProvider,
  resolvePlanPrices,
} from './billing';

describe('effectivePlan', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  it('keeps a paid plan until its expiry and returns free after', () => {
    expect(effectivePlan('pro', new Date('2026-11-02T00:00:00Z'), now)).toBe('pro');
    expect(effectivePlan('pro', new Date('2026-10-31T00:00:00Z'), now)).toBe('free');
    expect(effectivePlan('business', now, now)).toBe('free');
  });
  it('treats no expiry as permanent, and unknown names as free', () => {
    expect(effectivePlan('business', null, now)).toBe('business');
    expect(effectivePlan('gold', null, now)).toBe('free');
    expect(effectivePlan('free', new Date('2020-01-01'), now)).toBe('free');
  });
});

describe('addMonths', () => {
  it('adds calendar months and clamps the day', () => {
    expect(addMonths(new Date('2026-01-15T10:00:00Z'), 1).toISOString()).toBe('2026-02-15T10:00:00.000Z');
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths(new Date('2026-11-30T00:00:00Z'), 3).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(addMonths(new Date('2026-05-01T00:00:00Z'), 12).toISOString()).toBe('2027-05-01T00:00:00.000Z');
  });
});

describe('payment codes', () => {
  it('generates distinct, hand-typeable codes', () => {
    const codes = new Set(Array.from({ length: 200 }, generatePaymentCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^VOX[A-HJ-NP-Z2-9]{8}$/);
  });
  it('finds a code in a bank note whatever the case, spacing or separators', () => {
    const c = generatePaymentCode();
    expect(extractPaymentCode(`MBVCB.123 nang cap ${c} cam on`)).toBe(c);
    expect(extractPaymentCode(c.toLowerCase())).toBe(c);
    expect(extractPaymentCode(`${c.slice(0, 5)} ${c.slice(5)}`)).toBe(c);
    expect(extractPaymentCode(`${c.slice(0, 7)}-${c.slice(7)}`)).toBe(c);
    expect(extractPaymentCode('chuyen tien an trua')).toBeNull();
    expect(extractPaymentCode('VOX0O1I23')).toBeNull();
  });
});

describe('plan prices', () => {
  it('parses prices and rejects nonsense', () => {
    expect(resolvePlanPrices('')).toEqual({});
    expect(resolvePlanPrices('{"pro":99000,"business":299000}')).toEqual({ pro: 99000, business: 299000 });
    expect(() => resolvePlanPrices('{"pro":5}')).toThrow();
    expect(() => resolvePlanPrices('{"free":100000}')).toThrow();
  });
});

describe('generic payment provider', () => {
  it('authenticates only the exact bearer secret', () => {
    const secret = 'a-long-enough-shared-secret';
    expect(genericProvider.authenticate({ authorization: `Bearer ${secret}` }, secret)).toBe(true);
    expect(genericProvider.authenticate({ authorization: 'Bearer wrong' }, secret)).toBe(false);
    expect(genericProvider.authenticate({ authorization: secret }, secret)).toBe(false);
    expect(genericProvider.authenticate({}, secret)).toBe(false);
    expect(genericProvider.authenticate({ authorization: 'Bearer ' }, '')).toBe(false);
  });
  it('accepts exactly the normalized shape', () => {
    const ok = { eventId: 'e1', direction: 'in', amountVnd: 99000, note: 'VOXABCDEFGH' };
    expect(genericProvider.parse(ok).amountVnd).toBe(99000);
    expect(() => genericProvider.parse({ ...ok, extra: 1 })).toThrow();
    expect(() => genericProvider.parse({ ...ok, amountVnd: -5 })).toThrow();
    expect(() => genericProvider.parse({ ...ok, amountVnd: 1.5 })).toThrow();
    expect(() => genericProvider.parse({ ...ok, direction: 'sideways' })).toThrow();
  });
});
