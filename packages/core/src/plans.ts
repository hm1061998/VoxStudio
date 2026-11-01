import { PLAN_IDS, type PlanId } from '@voxstudio/contracts';
import { z } from 'zod';

/**
 * Service plans: scheduling priority and limits. Payment is out of scope: an administrator assigns a plan.
 * `priority` decides who goes first when capacity is short; aging (QUEUE_AGING_SECONDS) guarantees that a
 * waiting job of a lower plan eventually overtakes newer jobs of a higher plan, so nobody starves.
 */
export { PLAN_IDS, type PlanId };

export interface PlanLimits {
  /** Higher runs first. Also forwarded to the AI model service queue. */
  priority: number;
  /** Queued + running jobs a workspace may have. */
  maxPendingJobs: number;
  /** Characters per calendar month (UTC) the workspace may synthesize with AI engines; null = unlimited. */
  aiMonthlyChars: number | null;
  /** Bytes of stored audio (segments, exports, previews) a workspace may hold. */
  storageBytes: number;
  /** May export large uncompressed WAV (above 22.05 kHz mono 16-bit). */
  heavyExports: boolean;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const DEFAULT_PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    priority: 0,
    maxPendingJobs: 5,
    aiMonthlyChars: 20_000,
    storageBytes: 300 * MB,
    heavyExports: false,
  },
  pro: {
    priority: 10,
    maxPendingJobs: 15,
    aiMonthlyChars: 500_000,
    storageBytes: 5 * GB,
    heavyExports: true,
  },
  business: {
    priority: 20,
    maxPendingJobs: 20,
    aiMonthlyChars: null,
    storageBytes: 50 * GB,
    heavyExports: true,
  },
};

const limitsSchema = z.strictObject({
  priority: z.number().int().min(0).max(100),
  maxPendingJobs: z.number().int().min(1).max(1000),
  aiMonthlyChars: z.number().int().min(0).nullable(),
  storageBytes: z.number().int().min(0),
  heavyExports: z.boolean(),
});

/** Parse PLAN_LIMITS_JSON (partial overrides per plan). Throws on invalid input so a typo never goes unnoticed. */
export function resolvePlanLimits(json: string): Record<PlanId, PlanLimits> {
  if (!json.trim()) return DEFAULT_PLAN_LIMITS;
  const raw = z.partialRecord(z.enum(PLAN_IDS), limitsSchema.partial()).parse(JSON.parse(json));
  const out = { ...DEFAULT_PLAN_LIMITS };
  for (const id of PLAN_IDS) out[id] = limitsSchema.parse({ ...DEFAULT_PLAN_LIMITS[id], ...(raw[id] ?? {}) });
  if (!(out.free.priority <= out.pro.priority && out.pro.priority <= out.business.priority))
    throw new Error('PLAN_LIMITS_JSON: priority must not decrease from free to pro to business.');
  return out;
}

export const isPlanId = (v: string): v is PlanId => (PLAN_IDS as readonly string[]).includes(v);

/** Calendar month key (UTC), e.g. "2026-10". */
export const usageMonth = (d = new Date()): string => d.toISOString().slice(0, 7);

/** Effective scheduling score: base priority plus one point per `agingSeconds` waited (used by the queue SQL and tests). */
export function effectivePriority(priority: number, waitedSeconds: number, agingSeconds: number): number {
  return priority + Math.floor(Math.max(0, waitedSeconds) / Math.max(1, agingSeconds));
}
