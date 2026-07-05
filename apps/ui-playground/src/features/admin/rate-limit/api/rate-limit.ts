import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from '../../api/admin-client';

// ---------------------------------------------------------------------------
// Types — mirror the backend rate-limit admin surface (TASK-316):
//   - GET  /admin/rate-limit            → RateLimitPolicy
//   - PUT  /admin/rate-limit/enabled    → { enabled }
//   - PUT  /admin/rate-limit/tiers/:tier  → { limit?, ttl? }
//   - PUT  /admin/rate-limit/routes/:routeId → { limit?, ttl?, enabled? }
//
// IC-05: GLOBAL_ADMIN-only controller (`@Authorize(['manage','all'])`). It had
// no console consumer. Every setter returns the recomputed effective policy,
// so we replace the cached policy from the mutation result. This client only
// consumes the existing API — no backend changes.
// ---------------------------------------------------------------------------

export type RateLimitTierName = 'default' | 'strict' | 'heavy' | 'relaxed';
export type RateLimitValueSource = 'db' | 'code' | 'default';

export interface RateLimitTierPolicy {
  tier: RateLimitTierName;
  limit: number;
  ttl: number;
  limitSource: RateLimitValueSource;
  ttlSource: RateLimitValueSource;
}

export interface RateLimitRoutePolicy {
  routeId: string;
  controller: string;
  handler?: string;
  description: string;
  tier: RateLimitTierName;
  limit: number;
  ttl: number;
  enabled: boolean;
  limitSource: RateLimitValueSource;
  ttlSource: RateLimitValueSource;
}

export interface RateLimitPolicy {
  enabled: boolean;
  enabledSource: RateLimitValueSource;
  tiers: RateLimitTierPolicy[];
  routes: RateLimitRoutePolicy[];
}

export interface SetTierInput {
  tier: string;
  limit?: number;
  ttl?: number;
}

export interface SetRouteInput {
  routeId: string;
  limit?: number;
  ttl?: number;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const rateLimitKeys = {
  all: ['admin', 'rate-limit'] as const,
  policy: () => [...rateLimitKeys.all, 'policy'] as const,
};

// ---------------------------------------------------------------------------
// Query hook
// ---------------------------------------------------------------------------

export function useRateLimitPolicy(options?: Omit<UseQueryOptions<RateLimitPolicy>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: rateLimitKeys.policy(),
    queryFn: () => adminClient.get<RateLimitPolicy>('/admin/rate-limit'),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks — each returns the recomputed policy; seed the cache with it.
// ---------------------------------------------------------------------------

export function useSetRateLimitEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => adminClient.put<RateLimitPolicy>('/admin/rate-limit/enabled', { enabled }),
    onSuccess: (policy) => qc.setQueryData(rateLimitKeys.policy(), policy),
  });
}

export function useSetRateLimitTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tier, limit, ttl }: SetTierInput) => adminClient.put<RateLimitPolicy>(`/admin/rate-limit/tiers/${tier}`, { limit, ttl }),
    onSuccess: (policy) => qc.setQueryData(rateLimitKeys.policy(), policy),
  });
}

export function useSetRateLimitRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, limit, ttl, enabled }: SetRouteInput) =>
      adminClient.put<RateLimitPolicy>(`/admin/rate-limit/routes/${routeId}`, { limit, ttl, enabled }),
    onSuccess: (policy) => qc.setQueryData(rateLimitKeys.policy(), policy),
  });
}
