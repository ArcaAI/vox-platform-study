import Decimal from 'decimal.js';
import { AiCapability } from '@arcaai/domains';

/**
 * Pure linear burn-rate projection for `getBudgetBurndown` (TASK-615 WS-J).
 *
 * Simple linear projection, deliberately not a forecast model: given
 * month-to-date usage and the fraction of the month elapsed, project the
 * end-of-month total by scaling usage by `1 / fractionElapsed`. Flags
 * `projectedToExceed` when that projection would cross the allowance —
 * an early-warning signal, not a guarantee (D12's real enforcement is the
 * quota/spend-limit path elsewhere).
 */
export interface CapabilityBurndown {
  capability: AiCapability;
  /** null = unlimited (no allowance ceiling configured). */
  allowance: string | null;
  usedToDate: string;
  /** Linear projection to period end; null when the allowance is unlimited or no time has elapsed. */
  projectedTotal: string | null;
  /** True only when an allowance exists AND the projection exceeds it. */
  projectedToExceed: boolean;
  /** usedToDate / allowance, 0-100+; null when unlimited. */
  utilizationPercent: number | null;
}

/**
 * @param fractionElapsed (0, 1] — the share of the billing period that has
 *   passed. Callers compute this from `(now - periodStart) / (periodEnd -
 *   periodStart)`, clamped to (0, 1].
 */
export function projectCapabilityBurndown(capability: AiCapability, usedToDate: Decimal, allowance: Decimal | null, fractionElapsed: number): CapabilityBurndown {
  const used = usedToDate.isNegative() ? new Decimal(0) : usedToDate;

  if (allowance === null) {
    return { capability, allowance: null, usedToDate: used.toFixed(6), projectedTotal: null, projectedToExceed: false, utilizationPercent: null };
  }

  const clampedFraction = Math.min(Math.max(fractionElapsed, 1e-9), 1);
  const projected = used.dividedBy(clampedFraction);
  const utilization = allowance.isZero() ? (used.isZero() ? 0 : Infinity) : used.dividedBy(allowance).times(100).toNumber();

  return {
    capability,
    allowance: allowance.toFixed(6),
    usedToDate: used.toFixed(6),
    projectedTotal: projected.toFixed(6),
    projectedToExceed: projected.greaterThan(allowance),
    utilizationPercent: Number.isFinite(utilization) ? utilization : 100,
  };
}
