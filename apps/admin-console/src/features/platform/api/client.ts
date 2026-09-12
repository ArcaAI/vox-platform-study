/**
 * Platform overview reads (capabilities-matrix row 1) — SUPER_ADMIN only — plus
 * the one tenant-scoped read the Tenant Dashboard is built on (TASK-954).
 */

import { getJson } from '@/shared/api';
import type { ConsumptionRollup, OpenSockets, PlatformMetrics, TenantUsage } from './types';

export function getPlatformMetrics(): Promise<PlatformMetrics> {
  return getJson('admin/platform/metrics');
}

export function getOpenSockets(): Promise<OpenSockets> {
  return getJson('admin/platform/sockets');
}

/** Platform-wide when tenantId is omitted; per-tenant rollup otherwise. */
export function getConsumption(tenantId?: string): Promise<ConsumptionRollup> {
  return getJson('admin/platform/consumption', { tenantId });
}

/** One tenant's usage snapshot — a tenant admin reads its own; a cross-tenant id is 403 for them. */
export function getTenantUsage(tenantId: string): Promise<TenantUsage> {
  return getJson(`admin/tenants/${encodeURIComponent(tenantId)}/usage`);
}
