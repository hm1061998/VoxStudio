import { timingSafeEqual, randomInt } from 'node:crypto';
import { z } from 'zod';
import { isPlanId, type PlanId } from './plans';

/** Plans that can be bought. `free` is what everyone has when nothing is paid or the paid period ended. */
export const PAID_PLANS = ['pro', 'business'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
export const ORDER_MONTHS = [1, 3, 6, 12] as const;

/** The plan actually in force: a paid plan past its expiry counts as free; no expiry date means it does not lapse. */
export function effectivePlan(plan: string, expiresAt: Date | null | undefined, now = new Date()): PlanId {
  if (!isPlanId(plan)) return 'free';
  if (plan !== 'free' && expiresAt && expiresAt.getTime() <= now.getTime()) return 'free';
  return plan;
}

/** Calendar months added in UTC; the day is clamped (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// No 0/O or 1/I: the code is typed by hand into a bank transfer note.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /VOX[A-HJ-NP-Z2-9]{8}/;

export function generatePaymentCode(): string {
  let s = 'VOX';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

/** Finds a payment code in a bank transfer note. Banks change case and may insert spaces or separators. */
export function extractPaymentCode(note: string): string | null {
  const squeezed = note.toUpperCase().replace(/[\s\-_.]/g, '');
  return CODE_RE.exec(squeezed)?.[0] ?? null;
}

const pricesSchema = z.partialRecord(z.enum(PAID_PLANS), z.number().int().min(1000).max(100_000_000));

/** PLAN_PRICES_VND_JSON, e.g. {"pro":99000,"business":299000}: price per month in VND. Empty = billing is off. */
export function resolvePlanPrices(json: string): Partial<Record<PaidPlan, number>> {
  if (!json.trim()) return {};
  return pricesSchema.parse(JSON.parse(json));
}

/** One bank transfer as reported by a provider, in the shape the application understands. */
export interface PaymentEvent {
  /** Unique per provider; a repeated delivery carries the same id. */
  eventId: string;
  direction: 'in' | 'out';
  amountVnd: number;
  /** The transfer note written by the payer. */
  note: string;
}

export interface PaymentProvider {
  id: string;
  /** Checks the shared secret in the request headers. Must compare in constant time. */
  authenticate(headers: Record<string, string | string[] | undefined>, secret: string): boolean;
  /** Turns the provider's body into a PaymentEvent, or throws if the body is not valid. */
  parse(body: unknown): PaymentEvent;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const genericEvent = z.strictObject({
  eventId: z.string().min(1).max(100),
  direction: z.enum(['in', 'out']),
  amountVnd: z.number().int().min(1).max(1_000_000_000),
  note: z.string().max(500),
});

/**
 * The normalized format: `Authorization: Bearer <secret>` and a JSON body of {eventId, direction, amountVnd, note}.
 * Used by the tests and by any small bridge the operator writes. Adapters for real providers go next to it
 * (see docs/upgrade/11-BILLING.md); none is shipped because their payloads have not been verified.
 */
export const genericProvider: PaymentProvider = {
  id: 'generic',
  authenticate(headers, secret) {
    const h = headers['authorization'];
    const value = Array.isArray(h) ? h[0] : h;
    if (!secret || !value) return false;
    const m = /^Bearer (.+)$/.exec(value);
    return !!m && safeEqual(m[1]!, secret);
  },
  parse: (body) => genericEvent.parse(body),
};

export const PAYMENT_PROVIDERS: Record<string, PaymentProvider> = { [genericProvider.id]: genericProvider };
