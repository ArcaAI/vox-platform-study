import { EntityId } from '@arcaai/domains';
import { ShadowMeteringSweepResult, TenantDriftReport } from './dto/drift-report';

export const IShadowMeteringService = Symbol('IShadowMeteringService');

/**
 * Read-only shadow-metering report job (TASK-615 WS-K). Never blocks,
 * throttles, or corrects anything — it only compares surfaces and reports.
 */
export interface IShadowMeteringService {
  /** One tenant's report for the calendar month containing `now` (defaults to the current month). */
  runForTenant(tenantId: EntityId, now?: Date): Promise<TenantDriftReport>;

  /** Sweeps every tenant; used by the scheduled tick and available for an on-demand run. */
  runForAllActiveTenants(now?: Date): Promise<ShadowMeteringSweepResult>;
}
