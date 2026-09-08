/**
 * TASK-932 M1 — a matrix save must refresh the SHELL's own gate cache, not
 * only the matrix screen's own `effective()` query.
 *
 * `useFeatureGates()` (`@/shared/feature-gates/use-feature-gates`) reads a
 * SEPARATE query key (`['feature-gates']`) from this feature's own
 * `featureAvailabilityKeys.effective()` — the rail, sidebar and ⌘K all read
 * the shell key, so invalidating only the local one left the nav stale until
 * the next full reload.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_GATES_QUERY_KEY } from '@/shared/feature-gates/use-feature-gates';
import { usePutFeatureMatrix } from '../hooks';

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePutFeatureMatrix — onSuccess', () => {
  it('invalidates the shell feature-gates cache as well as the local matrix queries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ cells: [], errors: [] })),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Seed the shell's cache the way the rail/sidebar would on a real session,
    // so an invalidation has something to flip.
    queryClient.setQueryData(FEATURE_GATES_QUERY_KEY, { 'console.mlflow.enabled': false });

    const { result } = renderHook(() => usePutFeatureMatrix(), { wrapper: createWrapper(queryClient) });
    result.current.mutate([{ key: 'console.mlflow.enabled', tenantId: 'system', value: true }]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryState(FEATURE_GATES_QUERY_KEY)?.isInvalidated).toBe(true);
  });
});
