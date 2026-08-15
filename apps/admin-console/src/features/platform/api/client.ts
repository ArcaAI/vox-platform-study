/** Platform overview reads (capabilities-matrix row 1). SUPER_ADMIN only. */

import { getJson } from '@/shared/api';
import type { ConsumptionRollup, OpenSockets, PlatformMetrics } from './types';

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
