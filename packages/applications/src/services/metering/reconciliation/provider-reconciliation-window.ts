/**
 * Trailing-window arithmetic for provider reconciliation (rule 4).
 *
 * PURE — no clock of its own, no I/O — so the one rule that decides WHICH days
 * get reconciled is testable without a database or a provider account.
 *
 * ============================================================================
 * WHY A TRAILING WINDOW AND NOT "TODAY"
 * ============================================================================
 * Provider usage/cost APIs settle late: OpenAI's organization endpoints are
 * 1-day granular with undocumented freshness, Azure Cost Management refreshes
 * every ~4 hours against a daily grain, and every vendor reserves the right to
 * restate a day after the fact. Reconciling a day that has not settled produces
 * a drift alert that says nothing except "the provider has not finished
 * counting" — which trains an operator to ignore the alert, and a drift alert
 * nobody reads is worse than none.
 *
 * So the window ENDS `lagDays` before today's UTC midnight and covers
 * `windowDays` of already-settled days. With the defaults (lag 2, window 1) a
 * run on the 10th reconciles the 8th, whole and settled.
 */

/** UTC midnight of the day `date` falls in. */
function truncateToUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface ReconciliationWindow {
  /** Inclusive UTC start. */
  start: Date;
  /** EXCLUSIVE UTC end — half-open, the same boundary the rollups and billing periods use. */
  end: Date;
}

export interface ReconciliationWindowOptions {
  /**
   * Whole settled days to skip before the window ends. Must cover the provider's
   * worst-case restatement lag (T+1..T+3 across the vendors we reconcile).
   */
  lagDays?: number;
  /** Whole days the window spans. */
  windowDays?: number;
}

export const RECONCILIATION_WINDOW_DEFAULTS = { lagDays: 2, windowDays: 1 } as const;

/**
 * The settled window to reconcile as of `now`.
 *
 * Both inputs are clamped at 0/1 rather than throwing: this feeds a diagnostic
 * job that must never fail closed on a mis-set config value (rule 7). A
 * nonsensical `lagDays: -5` degrades to "no lag", which reconciles a possibly
 * unsettled day and shows up as drift — visible and recoverable, unlike a job
 * that stopped running.
 */
export function resolveReconciliationWindow(now: Date, options: ReconciliationWindowOptions = {}): ReconciliationWindow {
  const lagDays = Math.max(0, Math.floor(options.lagDays ?? RECONCILIATION_WINDOW_DEFAULTS.lagDays));
  const windowDays = Math.max(1, Math.floor(options.windowDays ?? RECONCILIATION_WINDOW_DEFAULTS.windowDays));

  const today = truncateToUtcDay(now);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - lagDays);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays);

  return { start, end };
}

/** `2026-08-08` — the label a run record and a drift alert carry. */
export function formatWindowLabel(window: ReconciliationWindow): string {
  const startLabel = window.start.toISOString().slice(0, 10);
  const lastDay = new Date(window.end);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const lastLabel = lastDay.toISOString().slice(0, 10);
  return startLabel === lastLabel ? startLabel : `${startLabel}..${lastLabel}`;
}
