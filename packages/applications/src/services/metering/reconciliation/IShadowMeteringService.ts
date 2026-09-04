import { EntityId } from '@arcaai/domains';
import { ShadowMeteringSweepResult, TenantDriftReport } from './dto/drift-report';

export const IShadowMeteringService = Symbol('IShadowMeteringService');

/**
 * Read-only shadow-metering report job. Never blocks,
 * throttles, or corrects anything — it only compares surfaces and reports.
 *
 * TASK-862: the provider (vendor-billing) reconciliation methods that used to
 * sit on this interface were removed outright with the feature.
 */
export interface IShadowMeteringService {
  /** One tenant's report for the calendar month containing `now` (defaults to the current month). */
  runForTenant(tenantId: EntityId, now?: Date): Promise<TenantDriftReport>;

  /** Sweeps every tenant; used by the scheduled tick and available for an on-demand run. */
  runForAllActiveTenants(now?: Date): Promise<ShadowMeteringSweepResult>;
}
