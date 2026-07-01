/**
 * TASK-392 (Phase 1) — pure helpers for composing the read-only
 * capability/usage snapshot. Kept free of NestJS/DB so the near-limit maths and
 * the trial-clock arithmetic are exhaustively unit-testable.
 */

import { TenantPlan } from '@arcaai/domains';
import { CapabilityUsageRow, TrialInfoResponse } from './dto';

/** Usage at/above this fraction of the limit flips `nearLimit`. */
export const NEAR_LIMIT_FRACTION = 0.8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Build one capability row from a resolved `limit` (null = unlimited) and the
 * live `used` count (null = not yet metered — M1–M3 before Phase 2).
 */
export function buildCapabilityRow(key: string, limit: number | null, used: number | null): CapabilityUsageRow {
  const unlimited = limit === null;

  if (used === null || used === undefined) {
    return { key, limit: limit ?? null, used: null, remaining: null, unlimited, nearLimit: false, exceeded: false };
  }

  const remaining = unlimited ? null : Math.max(0, (limit as number) - used);
  const nearLimit = !unlimited && (limit as number) > 0 && used / (limit as number) >= NEAR_LIMIT_FRACTION;
  const exceeded = !unlimited && used > (limit as number);

  return { key, limit: limit ?? null, used, remaining, unlimited, nearLimit, exceeded };
}

/**
 * Compute the trial-clock snapshot. `expired` flips once `trialEndsAt < now`
 * while still on the TRIAL plan (the scheduled job flips plan → STARTER
 * asynchronously; this reflects the display state in the meantime).
 */
export function computeTrialInfo(plan: TenantPlan | null, trialEndsAt: Date | null | undefined, now: Date = new Date()): TrialInfoResponse {
  const isTrial = plan === TenantPlan.TRIAL;

  if (!isTrial || !trialEndsAt) {
    return { isTrial, trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null, daysRemaining: null, expired: false };
  }

  const msLeft = trialEndsAt.getTime() - now.getTime();
  const expired = msLeft <= 0;
  const daysRemaining = expired ? 0 : Math.ceil(msLeft / MS_PER_DAY);

  return { isTrial: true, trialEndsAt: trialEndsAt.toISOString(), daysRemaining, expired };
}
