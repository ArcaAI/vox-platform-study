import { EntityId } from '@arcaai/domains';

/**
 * The three rolling-monthly meter values for one tenant/window.
 * `transcriptionMinutes` is whole minutes (rounded from summed audio-ms), to
 * match the integer `monthly*` limit columns.
 */
export interface MeterUsage {
  consultations: number;
  transcriptionMinutes: number;
  summaries: number;
}

/**
 * Rolling-monthly metering contract.
 *
 * Reads (`getCurrentUsage`) are a LIVE Postgres aggregate over the current UTC
 * calendar-month window — authoritative and near-realtime, correct even when
 * the reconcile job is off. `reconcileTenant` / `reconcileAllActiveTenants`
 * PERSIST those aggregates into `TenantUsageMeter` (the job body). All queries
 * are cross-tenant-safe (explicit `tenantId`, unscoped base client) so the job
 * can run with no CLS tenant context.
 */
export interface IMeteringService {
  /** Live aggregate of the CURRENT month window for one tenant (no writes). */
  getCurrentUsage(tenantId: EntityId, now?: Date): Promise<MeterUsage>;

  /** Aggregate + upsert the tenant's three meter rows for the current window. */
  reconcileTenant(tenantId: EntityId, now?: Date): Promise<MeterUsage>;

  /** Reconcile every tenant (the scheduled-job body). Returns the count done. */
  reconcileAllActiveTenants(now?: Date): Promise<{ tenants: number }>;
}

export const IMeteringService = Symbol('IMeteringService');
