'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRateLimitRule,
  deleteRateLimitRule,
  explainRateLimit,
  getRateLimitPolicy,
  listRateLimitPlans,
  listRateLimitRules,
  listRouteCatalog,
  listTenantOptions,
  setRateLimitEnabled,
  setRateLimitPlan,
  setRouteOverride,
  setTierOverride,
  updateRateLimitRule,
} from './client';
import { rateLimitKeys, rateLimitPlanKeys, rateLimitRuleKeys, rateLimitTenantKeys } from './keys';
import type {
  RateLimitPolicy,
  RateLimitTier,
  SetRateLimitPlanRequest,
  SetRouteOverrideRequest,
  SetTierOverrideRequest,
  UpdateRateLimitRuleRequest,
} from './types';

export function useRateLimitPolicy() {
  return useQuery({ queryKey: rateLimitKeys.policy(), queryFn: getRateLimitPolicy });
}

/** Writes return the fresh policy — write it straight into the cache. */
function useSetPolicyCache() {
  const queryClient = useQueryClient();
  return (policy: RateLimitPolicy) => queryClient.setQueryData(rateLimitKeys.policy(), policy);
}

export function useSetRateLimitEnabled() {
  const setCache = useSetPolicyCache();
  return useMutation({ mutationFn: (enabled: boolean) => setRateLimitEnabled(enabled), onSuccess: setCache });
}

export function useSetTierOverride() {
  const setCache = useSetPolicyCache();
  return useMutation({
    mutationFn: ({ tier, body }: { tier: RateLimitTier; body: SetTierOverrideRequest }) => setTierOverride(tier, body),
    onSuccess: setCache,
  });
}

export function useSetRouteOverride() {
  const setCache = useSetPolicyCache();
  return useMutation({
    mutationFn: ({ routeId, body }: { routeId: string; body: SetRouteOverrideRequest }) => setRouteOverride(routeId, body),
    onSuccess: setCache,
  });
}

// ---------------------------------------------------------------------------
// Rules, route catalog, explain (TASK-785)
// ---------------------------------------------------------------------------

export function useRateLimitRules(params: { scope?: 'platform' | 'tenant'; tenantId?: string } = {}) {
  return useQuery({
    queryKey: rateLimitRuleKeys.list(params.scope, params.tenantId),
    queryFn: () => listRateLimitRules(params),
  });
}

/** The route inventory is fixed for the gateway's lifetime — cache it hard. */
export function useRouteCatalog() {
  return useQuery({ queryKey: rateLimitRuleKeys.routes(), queryFn: listRouteCatalog, staleTime: Infinity });
}

function useInvalidateRules() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: rateLimitRuleKeys.root });
}

export function useCreateRateLimitRule() {
  const invalidate = useInvalidateRules();
  return useMutation({ mutationFn: createRateLimitRule, onSuccess: invalidate });
}

export function useUpdateRateLimitRule() {
  const invalidate = useInvalidateRules();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateRateLimitRuleRequest }) => updateRateLimitRule(id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteRateLimitRule() {
  const invalidate = useInvalidateRules();
  return useMutation({ mutationFn: (id: string) => deleteRateLimitRule(id), onSuccess: invalidate });
}

/**
 * Resolution trace for one tenant + route. Disabled until a route is chosen —
 * `explain` is a deliberate action, not something to fire on every keystroke.
 */
export function useExplainRateLimit(args: { method: string; path: string; tenantId?: string }, enabled: boolean) {
  return useQuery({
    queryKey: rateLimitRuleKeys.explain(args.tenantId ?? null, args.method, args.path),
    queryFn: () => explainRateLimit(args),
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Subscription plans — rank 3 (TASK-785 US-3)
// ---------------------------------------------------------------------------

export function useRateLimitPlans() {
  return useQuery({ queryKey: rateLimitPlanKeys.list(), queryFn: listRateLimitPlans });
}

export function useSetRateLimitPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ plan, body }: { plan: string; body: SetRateLimitPlanRequest }) => setRateLimitPlan(plan, body),
    // The response is one plan; refetch the list so the OCC version every other
    // row holds stays the one the server has.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rateLimitPlanKeys.root }),
  });
}

/** Tenants for the rule picker. Effectively static within a session. */
export function useTenantOptions() {
  return useQuery({ queryKey: rateLimitTenantKeys.options(), queryFn: listTenantOptions, staleTime: 5 * 60 * 1000 });
}
