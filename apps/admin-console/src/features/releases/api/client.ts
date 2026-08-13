import { getJson, type Paginated } from '@/shared/api';

import type { CurrentService, Environment, ServiceRelease, ServiceReleaseListParams } from './types';

/**
 * Typed calls over the BFF proxy against `admin/service-releases/*`
 * (`@CanAny(['manage','all'], ['read','TenantTelemetry'])` — the same gate as
 * `/health/services`, per the frozen contract).
 */
const BASE = 'admin/service-releases';

/** Latest LIVE instance per service for one environment. */
export function getCurrentReleases(environment: Environment): Promise<CurrentService[]> {
  return getJson(`${BASE}/current`, { environment });
}

/** Release history across all services, newest build first. */
export function listServiceReleases(params?: ServiceReleaseListParams): Promise<Paginated<ServiceRelease>> {
  return getJson(BASE, params);
}

/** Release timeline for one service, newest first. */
export function getServiceReleaseHistory(serviceName: string): Promise<ServiceRelease[]> {
  return getJson(`${BASE}/${encodeURIComponent(serviceName)}/history`);
}
