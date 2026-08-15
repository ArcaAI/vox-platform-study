import { EntityId } from '@arcaai/domains';
import { ProviderReconciliationSweepResult, ShadowMeteringSweepResult, TenantDriftReport } from './dto/drift-report';
import { ProviderReconciliationRunResponse } from './dto/provider-reconciliation-run.response';
import type { ProviderReconciliationRunQuery } from '@arcaai/domains';

export const IShadowMeteringService = Symbol('IShadowMeteringService');

/**
 * Read-only shadow-metering report job. Never blocks,
 * throttles, or corrects anything — it only compares surfaces and reports.
 */
export interface IShadowMeteringService {
  /** One tenant's report for the calendar month containing `now` (defaults to the current month). */
  runForTenant(tenantId: EntityId, now?: Date): Promise<TenantDriftReport>;

  /** Sweeps every tenant; used by the scheduled tick and available for an on-demand run. */
  runForAllActiveTenants(now?: Date): Promise<ShadowMeteringSweepResult>;

  /** Reconcile the ledger against each provider's own report for the last settled window. */
  reconcileProviders(now?: Date): Promise<ProviderReconciliationSweepResult>;

  /** The audit report — newest first. SUPER_ADMIN-only at the call site: these are PLATFORM vendor totals. */
  findReconciliationRuns(query?: ProviderReconciliationRunQuery): Promise<ProviderReconciliationRunResponse[]>;

  /** Most recent run per provider — the status-board read. */
  findLatestReconciliationPerProvider(): Promise<ProviderReconciliationRunResponse[]>;
}
