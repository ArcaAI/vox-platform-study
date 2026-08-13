import { EntityId } from '@arcaai/domains';
import { DriftResult } from '../drift-math';

/** One tenant's shadow-metering report for one calendar-month window. */
export interface TenantDriftReport {
  tenantId: EntityId;
  periodStart: Date;
  periodEnd: Date;
  comparisons: DriftResult[];
  breaches: DriftResult[];
  /** Provider-reconciler rows attempted for this run — see `provider-reconciler-registry.ts` for the two availability gates. */
  providerAvailability: Array<{ provider: string; available: boolean; reason?: string }>;
}

/**
 * One provider's reconciliation outcome for a settled window.
 *
 * PLATFORM-WIDE, never a tenant slice: no vendor exposes per-tenant cost, so
 * this compares the ledger's own CLOUD-only control total against what the
 * vendor says it billed the platform.
 */
export interface ProviderReconciliationResult {
  provider: string;
  /** e.g. `2026-08-06` (or `2026-08-04..2026-08-06` for a multi-day window). */
  window: string;
  windowStart: Date;
  windowEnd: Date;
  /** `skipped` = not reconcilable yet (no client / no credential) · `failed` = the vendor call errored. */
  status: 'reconciled' | 'skipped' | 'failed';
  /** Why, when the status is not `reconciled`. */
  reason?: string;
  /** Ledger CLOUD-only quantity for the window. Present when reconciled. */
  ledgerQuantity?: number;
  /** The vendor's reported quantity, in THEIR unit vocabulary. */
  providerQuantity?: number;
  providerUnit?: string;
  /** Signed `(provider - ledger) / ledger`; `null` when the ratio is undefined. */
  relativeDrift?: number | null;
  breachesThreshold?: boolean;
}

/** What one provider-reconciliation sweep produced. */
export interface ProviderReconciliationSweepResult {
  window: string;
  results: ProviderReconciliationResult[];
  reconciled: number;
  skipped: number;
  failed: number;
  breaches: number;
}

/** The full sweep's summary — what the scheduled tick logs. */
export interface ShadowMeteringSweepResult {
  tenants: number;
  tenantsWithBreaches: number;
  totalBreaches: number;
  reports: TenantDriftReport[];
}
