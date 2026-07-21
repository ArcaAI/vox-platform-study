/**
 * Pure calendar-month window maths for rolling-monthly
 * metering.
 *
 * A metering window is a UTC calendar month, half-open:
 *   [first millisecond of the month, first millisecond of the NEXT month)
 * so consecutive windows tile the timeline with no gap or overlap and a row's
 * `createdAt`/`generatedAt` belongs to exactly one window. Kept free of
 * NestJS/DB so the arithmetic is exhaustively unit-testable and shared by both
 * the on-demand live aggregate and the reconcile job.
 */

export interface UsageWindow {
  /** Inclusive lower bound — 00:00:00.000 UTC on the 1st of the month. */
  periodStart: Date;
  /** Exclusive upper bound — 00:00:00.000 UTC on the 1st of the NEXT month. */
  periodEnd: Date;
}

/**
 * The UTC calendar-month window containing `now`. `Date.UTC` rolls the month
 * over the year boundary automatically (December → next January).
 */
export function currentMonthWindow(now: Date = new Date()): UsageWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    periodStart: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}
