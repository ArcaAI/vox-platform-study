import { ArgumentInvalidException } from '@arcaai/exceptions';

/**
 * Billing-period arithmetic.
 *
 * A billing period is a HALF-OPEN UTC calendar month `[start, end)` — the same
 * boundary the daily rollups and `TenantUsageMeter` use (D13), so allowances,
 * meters and invoices can never disagree about which month a call fell in.
 *
 * PURE. No clock, no DI — period math is money math and must be reviewable on
 * its own.
 */
export interface BillingPeriod {
  /** First instant of the month, UTC. */
  start: Date;
  /** First instant of the NEXT month, UTC (exclusive). */
  end: Date;
  /** Canonical `YYYY-MM` label. */
  label: string;
}

const PERIOD_SHAPE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Parse a `YYYY-MM` label into a half-open UTC month. */
export function parseBillingPeriod(period: string): BillingPeriod {
  const match = PERIOD_SHAPE.exec(period);
  if (!match) {
    throw new ArgumentInvalidException(`Billing period must be "YYYY-MM" (got "${period}")`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-based
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
    label: period,
  };
}

/** The period containing `date` (UTC month). */
export function periodOf(date: Date): BillingPeriod {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const label = `${year}-${String(month + 1).padStart(2, '0')}`;
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)), label };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Truncate to UTC midnight — the rollup day-bucket boundary. */
export function truncateToUtcDay(date: Date): Date {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);
}

/**
 * UTC calendar days owned by the half-open range `[from, to)`, by DAY-BUCKET
 * OWNERSHIP: a range owns the day it starts and does NOT own the day it ends.
 *
 * That single rule makes daily proration partition-exact: for a plan change at
 * any intra-day instant `t`, `utcDayCount(start, t) + utcDayCount(t, end)`
 * always equals the period's day count — no double-count, no gap (D15).
 */
export function utcDayCount(from: Date, to: Date): number {
  const days = Math.round((truncateToUtcDay(to).getTime() - truncateToUtcDay(from).getTime()) / DAY_MS);
  return Math.max(0, days);
}
