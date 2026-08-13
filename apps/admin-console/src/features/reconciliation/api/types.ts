/**
 * Wire types for the provider-reconciliation audit trail,
 * backed by `admin/usage/reconciliation/*`. Re-declared locally (rule 13).
 *
 * Quantities ride as STRINGS (Decimal columns), and `null` is MEANINGFUL: a
 * skipped or failed run genuinely produced no comparison, which is not the same
 * as a vendor reporting zero.
 */

export type ReconciliationStatus = 'reconciled' | 'skipped' | 'failed';

export interface ReconciliationRun {
  id: string;
  provider: string;
  window: string;
  windowStart: string;
  windowEnd: string;
  status: ReconciliationStatus;
  reason: string | null;
  ledgerQuantity: string | null;
  providerQuantity: string | null;
  providerUnit: string | null;
  relativeDrift: string | null;
  breachedThreshold: boolean;
  thresholdPct: number;
  runAt: string;
}

export interface ReconciliationSweepResult {
  window: string;
  reconciled: number;
  skipped: number;
  failed: number;
  breaches: number;
}

export interface ReconciliationRunsParams {
  provider?: string;
  breachedOnly?: boolean;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}
