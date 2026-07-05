/**
 * @arcaai/vox - useRateLimits Hook (TASK-403)
 *
 * Global-admin rate-limit configuration surface over the TASK-316 substrate
 * (`/admin/rate-limit`, `manage all` only). Every mutation returns the fresh
 * full policy, so state is simply replaced — no local merging.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { RATE_LIMIT_ADMIN_ENDPOINTS } from '../core/constants';
import type { RateLimitPolicy, SetRateLimitRouteInput, SetRateLimitTierInput } from '../types/ops-admin';

export interface UseRateLimitsReturn {
  /** Effective policy (global flag + tier baselines + known-route overrides). Null until first refresh. */
  policy: RateLimitPolicy | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<RateLimitPolicy>;
  /** Flip the global kill-switch. */
  setEnabled: (enabled: boolean) => Promise<RateLimitPolicy>;
  /** Update a tier baseline (default | strict | heavy | relaxed). */
  setTier: (tier: string, input: SetRateLimitTierInput) => Promise<RateLimitPolicy>;
  /** Update a per-endpoint override for a known throttled route (e.g. `auth.login`). */
  setRoute: (routeId: string, input: SetRateLimitRouteInput) => Promise<RateLimitPolicy>;
}

export function useRateLimits(): UseRateLimitsReturn {
  const { execute, isLoading, error } = useApiOperation('useRateLimits');
  const [policy, setPolicy] = useState<RateLimitPolicy | null>(null);

  const refresh = useCallback(
    () =>
      execute<RateLimitPolicy>('refresh', async (client) => {
        const data = await client.get<RateLimitPolicy>(RATE_LIMIT_ADMIN_ENDPOINTS.POLICY);
        setPolicy(data);
        return data;
      }),
    [execute],
  );

  const setEnabled = useCallback(
    (enabled: boolean) =>
      execute<RateLimitPolicy>('setEnabled', async (client) => {
        const data = await client.put<RateLimitPolicy>(RATE_LIMIT_ADMIN_ENDPOINTS.SET_ENABLED, { enabled });
        setPolicy(data);
        return data;
      }),
    [execute],
  );

  const setTier = useCallback(
    (tier: string, input: SetRateLimitTierInput) =>
      execute<RateLimitPolicy>('setTier', async (client) => {
        const data = await client.put<RateLimitPolicy>(RATE_LIMIT_ADMIN_ENDPOINTS.SET_TIER(tier), input);
        setPolicy(data);
        return data;
      }),
    [execute],
  );

  const setRoute = useCallback(
    (routeId: string, input: SetRateLimitRouteInput) =>
      execute<RateLimitPolicy>('setRoute', async (client) => {
        const data = await client.put<RateLimitPolicy>(RATE_LIMIT_ADMIN_ENDPOINTS.SET_ROUTE(routeId), input);
        setPolicy(data);
        return data;
      }),
    [execute],
  );

  return { policy, isLoading, error, refresh, setEnabled, setTier, setRoute };
}
