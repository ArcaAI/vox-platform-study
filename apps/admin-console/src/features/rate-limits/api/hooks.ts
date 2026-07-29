'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRateLimitPolicy, setRateLimitEnabled, setRouteOverride, setTierOverride } from './client';
import { rateLimitKeys } from './keys';
import type { RateLimitPolicy, RateLimitTier, SetRouteOverrideRequest, SetTierOverrideRequest } from './types';

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
