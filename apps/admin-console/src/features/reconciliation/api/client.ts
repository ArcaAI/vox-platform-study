import { getJson, postJson } from '@/shared/api';

import type { ReconciliationRun, ReconciliationRunsParams, ReconciliationSweepResult } from './types';

/** Typed calls over the BFF proxy. All routes are GLOBAL_ADMIN-only, enforced server-side. */
const BASE = 'admin/usage/reconciliation';

export function getReconciliationRuns(params?: ReconciliationRunsParams): Promise<ReconciliationRun[]> {
  return getJson(`${BASE}/runs`, params);
}

export function getLatestPerProvider(): Promise<ReconciliationRun[]> {
  return getJson(`${BASE}/latest`);
}

/**
 * Run the sweep now. Reads the ledger and each vendor report and appends audit
 * rows — it never writes to the ledger. Exposed because the scheduled sweep
 * ships OFF, so without it the trail stays empty.
 */
export function runReconciliation(): Promise<ReconciliationSweepResult> {
  return postJson(`${BASE}/run`, {});
}
