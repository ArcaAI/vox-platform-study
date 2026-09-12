import { getJson } from '@/shared/api';

import type {
  CostPerEncounterResponse,
  TopTenantsResponse,
  UsageConnection,
  UsagePeriodParams,
  UsagePlatformDefaults,
  UsageSummaryResponse,
} from './types';

/**
 * Typed reads over the BFF proxy. Paths are gateway-relative
 * (relative to `/api/v1`, no leading slash). `summary` / `cost-per-encounter`
 * are tenant-scoped (the proxy attaches `X-Tenant-Id` from the working tenant);
 * `top-tenants` is cross-tenant (SUPER_ADMIN, enforced server-side).
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

/**
 * TASK-958 D-7 — the working tenant's connections for one capability, read ONLY
 * to name the `connectionId` on a usage line.
 *
 * Read here rather than imported from `features/ai-providers`: features never
 * import one another (rule 13 §Structure), and what this screen needs is three
 * ids and a label off a plain GET — the same reasoning that put
 * `getInferenceReadiness` in the AI-providers client. Tenancy comes from the
 * proxy's `X-Tenant-Id` (the working tenant), exactly like the usage reads
 * beside it, so no tenant parameter is threaded through.
 */
export function getUsageConnections(service: 'llm' | 'stt' | 'tts'): Promise<UsageConnection[]> {
  return getJson(`admin/providers/${service}`);
}

/**
 * TASK-958 (wire review #6) — the PLATFORM rows the working tenant inherits for
 * one capability, read for the same reason and in the same way: to NAME the
 * `connectionId` on a usage line.
 *
 * A platform-funded line carries the SYSTEM row's id, which is absent from the
 * tenant's own list by construction, so without this read it could only ever
 * render as an unresolved id.
 */
export function getUsagePlatformDefaults(service: 'llm' | 'stt' | 'tts'): Promise<UsagePlatformDefaults> {
  return getJson(`admin/providers/${service}/platform-defaults`);
}
