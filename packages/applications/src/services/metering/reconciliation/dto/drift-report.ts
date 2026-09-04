import { EntityId } from '@arcaai/domains';
import { DriftResult } from '../drift-math';

/** One tenant's shadow-metering report for one calendar-month window. */
export interface TenantDriftReport {
  tenantId: EntityId;
  periodStart: Date;
  periodEnd: Date;
  comparisons: DriftResult[];
  breaches: DriftResult[];
}

/** The full sweep's summary — what the scheduled tick logs. */
export interface ShadowMeteringSweepResult {
  tenants: number;
  tenantsWithBreaches: number;
  totalBreaches: number;
  reports: TenantDriftReport[];
}
