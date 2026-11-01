import { z } from 'zod';

/** Service plans (see docs/upgrade/09-AI-ENGINE-CAPACITY.md). An administrator assigns them; there is no billing. */
export const PLAN_IDS = ['free', 'pro', 'business'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** An administrator sets a plan, optionally with the moment it stops applying (null or absent = no expiry). */
export const workspacePlanSchema = z.strictObject({
  plan: z.enum(PLAN_IDS),
  expiresAt: z.iso.datetime().nullable().optional(),
});

export const PAID_PLAN_IDS = ['pro', 'business'] as const;
export const ORDER_MONTH_CHOICES = [1, 3, 6, 12] as const;
export const ORDER_STATUSES = ['pending', 'paid', 'review', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orderCreateSchema = z.strictObject({
  plan: z.enum(PAID_PLAN_IDS),
  months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
});
export const orderDecisionSchema = z.strictObject({ note: z.string().trim().max(300).optional() });
export const paymentEventResolveSchema = z.strictObject({
  action: z.enum(['attach', 'extend', 'dismiss']),
  orderId: z.string().uuid().optional(),
  note: z.string().trim().max(300).optional(),
});

export interface BillingInfoDto {
  /** false when no prices are configured: administrators assign plans and nothing can be bought. */
  enabled: boolean;
  /** Price per month in VND for each paid plan. */
  prices: Partial<Record<(typeof PAID_PLAN_IDS)[number], number>>;
  months: number[];
  bank: { name: string; account: string; holder: string } | null;
  /** true when a provider webhook is configured (payments confirm themselves) */
  autoConfirm: boolean;
}

export interface OrderDto {
  id: string;
  plan: PlanId;
  months: number;
  amountVnd: number;
  paymentCode: string;
  status: OrderStatus;
  paidAmountVnd: number | null;
  paidAt: string | null;
  paidVia: string | null;
  createdAt: string;
  expiresAt: string;
  note: string | null;
}

export interface AdminOrderDto extends OrderDto {
  workspaceId: string;
  workspaceName: string;
  ownerEmail: string;
}

export interface AdminPaymentEventDto {
  id: string;
  provider: string;
  amountVnd: number;
  note: string;
  result: string;
  orderId: string | null;
  createdAt: string;
}

export interface PlanDto {
  workspaceId: string;
  plan: PlanId;
  /** Scheduling priority; higher plans are served first when capacity is short. */
  priority: number;
  maxPendingJobs: number;
  pendingJobs: number;
  /** null = unlimited */
  aiMonthlyChars: number | null;
  aiUsedChars: number;
  /** Bytes of stored audio allowed / currently stored for the workspace. */
  storageBytes: number;
  storageUsedBytes: number;
  /** May export large uncompressed WAV. */
  heavyExports: boolean;
  /** When the paid plan stops applying; null = no expiry (or the free plan). */
  planExpiresAt: string | null;
  /** 'YYYY-MM' (UTC) the usage refers to */
  month: string;
}

export interface AdminWorkspaceDto {
  id: string;
  name: string;
  ownerEmail: string;
  plan: PlanId;
  aiUsedChars: number;
  pendingJobs: number;
  /** When the paid plan stops applying; null = no expiry. */
  planExpiresAt: string | null;
}
