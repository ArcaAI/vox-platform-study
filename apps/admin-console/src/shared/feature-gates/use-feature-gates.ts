'use client';

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { getEffectiveFeatureGates } from './client';
import type { FeatureGateMap } from './keys';

/** One shared cache entry for the whole session — every consumer (rail, sidebar, ⌘K, route boundaries) dedupes onto it. */
export const FEATURE_GATES_QUERY_KEY = ['feature-gates'] as const;

/**
 * The platform-wide feature-availability map (TASK-932 §3.2), resolved once
 * per session and shared across the shell.
 *
 * `gates` is NEVER `undefined`: on first render, on a fetch error, or on a
 * 404 (the endpoint not yet reachable), it is `{}` — an empty map reads as
 * "every gate closed" to every consumer, which is the fail-closed posture the
 * settings-registry cascade already applies server-side. Callers do not need
 * their own error branch; they just read `gates[key] === true`.
 */
export function useFeatureGates(): { gates: FeatureGateMap; isLoading: boolean; isError: boolean } {
  const query = useQuery({
    queryKey: FEATURE_GATES_QUERY_KEY,
    queryFn: getEffectiveFeatureGates,
    staleTime: 30_000,
  });

  return {
    gates: query.data ?? {},
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Lane S calls this after a matrix save so every open session re-resolves gates on next read. */
export function invalidateFeatureGates(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: FEATURE_GATES_QUERY_KEY });
}
