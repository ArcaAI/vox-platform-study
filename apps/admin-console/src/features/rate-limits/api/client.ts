/** Rate-limit policy admin (capabilities-matrix row 7). Every write returns the full policy. */

import { deleteJson, getJson, getWithEtag, patchJson, patchWithEtag, postJson, putJson } from '@/shared/api';
import type {
  CreateRateLimitRuleRequest,
  RateLimitExplainResult,
  RateLimitPolicy,
  RateLimitRule,
  RateLimitTier,
  RateLimitPlan,
  RouteCatalogEntry,
  SetRateLimitPlanRequest,
  SetRouteOverrideRequest,
  TenantOption,
  SetTierOverrideRequest,
  UpdateRateLimitRuleRequest,
} from './types';

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

// ---------------------------------------------------------------------------
// Rules, route catalog, explain (TASK-785)
// ---------------------------------------------------------------------------

const RULES = `${BASE}/rules`;

export function listRateLimitRules(params: { scope?: 'platform' | 'tenant'; tenantId?: string } = {}): Promise<RateLimitRule[]> {
  return getJson(RULES, params);
}

export function listRouteCatalog(): Promise<RouteCatalogEntry[]> {
  return getJson(`${BASE}/routes`);
}

export function createRateLimitRule(body: CreateRateLimitRuleRequest): Promise<RateLimitRule> {
  return postJson(RULES, body);
}

/**
 * Rules are OCC-written: the gateway requires `If-Match` (428 without it, 412 on
 * drift), so read the row's ETag immediately before writing rather than trusting
 * a possibly-stale list.
 */
export async function updateRateLimitRule(id: string, body: UpdateRateLimitRuleRequest): Promise<RateLimitRule> {
  const current = await getWithEtag<RateLimitRule>(`${RULES}/${id}`);
  const result = await patchWithEtag<RateLimitRule>(`${RULES}/${id}`, body, current.etag ?? '');
  return result.data;
}

export function deleteRateLimitRule(id: string): Promise<void> {
  return deleteJson(`${RULES}/${id}`);
}

export function explainRateLimit(args: { method: string; path: string; tenantId?: string }): Promise<RateLimitExplainResult> {
  return getJson(`${BASE}/explain`, args);
}

// ---------------------------------------------------------------------------
// Subscription plans — rank 3 (TASK-785 US-3)
// ---------------------------------------------------------------------------

export function listRateLimitPlans(): Promise<RateLimitPlan[]> {
  return getJson(`${BASE}/plans`);
}

export function setRateLimitPlan(plan: string, body: SetRateLimitPlanRequest): Promise<RateLimitPlan> {
  return patchJson(`${BASE}/plans/${encodeURIComponent(plan)}`, body);
}

/**
 * Tenant options for the rule picker. Hits the tenants admin route directly
 * rather than importing `features/tenants` — features never import each other.
 * One generous page: the picker is a lookup, not a browsing surface.
 */
export async function listTenantOptions(): Promise<TenantOption[]> {
  const page = await getJson<{ data: Array<{ id: string; name: string }> }>('admin/tenants', { limit: 200, sort: 'name:asc' });
  return (page.data ?? []).map((tenant) => ({ id: tenant.id, name: tenant.name }));
}
