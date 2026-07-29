/** Rate-limit policy admin (capabilities-matrix row 7). Every write returns the full policy. */

import { getJson, putJson } from '@/shared/api';
import type { RateLimitPolicy, RateLimitTier, SetRouteOverrideRequest, SetTierOverrideRequest } from './types';

const BASE = 'admin/rate-limit';

export function getRateLimitPolicy(): Promise<RateLimitPolicy> {
  return getJson(BASE);
}

/** Global kill-switch. */
export function setRateLimitEnabled(enabled: boolean): Promise<RateLimitPolicy> {
  return putJson(`${BASE}/enabled`, { enabled });
}

export function setTierOverride(tier: RateLimitTier, body: SetTierOverrideRequest): Promise<RateLimitPolicy> {
  return putJson(`${BASE}/tiers/${tier}`, body);
}

/** routeId is "controller#handler" — encode it (contains '#'). */
export function setRouteOverride(routeId: string, body: SetRouteOverrideRequest): Promise<RateLimitPolicy> {
  return putJson(`${BASE}/routes/${encodeURIComponent(routeId)}`, body);
}
