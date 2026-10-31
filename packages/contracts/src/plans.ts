import { z } from 'zod';

/** Service plans (see docs/upgrade/09-AI-ENGINE-CAPACITY.md). An administrator assigns them; there is no billing. */
export const PLAN_IDS = ['free', 'pro', 'business'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const workspacePlanSchema = z.strictObject({ plan: z.enum(PLAN_IDS) });

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
}
