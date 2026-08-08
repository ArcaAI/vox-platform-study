import { getJson } from '@/shared/api';

import type { CostPerEncounterResponse, TopTenantsResponse, UsagePeriodParams, UsageSummaryResponse } from './types';

/**
 * Typed reads over the BFF proxy (TASK-615 #15a). Paths are gateway-relative
 * (relative to `/api/v1`, no leading slash). `summary` / `cost-per-encounter`
 * are tenant-scoped (the proxy attaches `X-Tenant-Id` from the working tenant);
 * `top-tenants` is cross-tenant (GLOBAL_ADMIN, enforced server-side).
 */
const USAGE = 'admin/usage';

export function getUsageSummary(params?: UsagePeriodParams): Promise<UsageSummaryResponse> {
  return getJson(`${USAGE}/summary`, params);
}

export function getCostPerEncounter(params?: UsagePeriodParams): Promise<CostPerEncounterResponse> {
  return getJson(`${USAGE}/cost-per-encounter`, params);
}

export function getTopTenants(params?: UsagePeriodParams): Promise<TopTenantsResponse> {
  return getJson(`${USAGE}/top-tenants`, params);
}
