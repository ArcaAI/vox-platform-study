import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRateLimitPolicy, useSetRateLimitEnabled, useSetRateLimitRoute, useSetRateLimitTier } from '../rate-limit';

vi.mock('../../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../../../api/admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
const mockPut = adminClient.put as ReturnType<typeof vi.fn>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const POLICY = { enabled: true, enabledSource: 'default', tiers: [], routes: [] };

// ---------------------------------------------------------------------------
// IC-05 — surface the EXISTING SUPER_ADMIN rate-limit admin API. The hooks must
// hit the exact controller routes with the typed bodies.
// ---------------------------------------------------------------------------
describe('Rate Limits (IC-05) API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useRateLimitPolicy GETs /admin/rate-limit', async () => {
    mockGet.mockResolvedValueOnce(POLICY);

    const { result } = renderHook(() => useRateLimitPolicy(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/rate-limit');
  });

  it('useSetRateLimitEnabled PUTs the kill-switch to /admin/rate-limit/enabled', async () => {
    mockPut.mockResolvedValueOnce({ ...POLICY, enabled: false });

    const { result } = renderHook(() => useSetRateLimitEnabled(), { wrapper: createWrapper() });
    result.current.mutate(false);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPut).toHaveBeenCalledWith('/admin/rate-limit/enabled', { enabled: false });
  });

  it('useSetRateLimitTier PUTs limit/ttl to /admin/rate-limit/tiers/:tier', async () => {
    mockPut.mockResolvedValueOnce(POLICY);

    const { result } = renderHook(() => useSetRateLimitTier(), { wrapper: createWrapper() });
    result.current.mutate({ tier: 'strict', limit: 5, ttl: 60000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPut).toHaveBeenCalledWith('/admin/rate-limit/tiers/strict', { limit: 5, ttl: 60000 });
  });

  it('useSetRateLimitRoute PUTs the override to /admin/rate-limit/routes/:routeId', async () => {
    mockPut.mockResolvedValueOnce(POLICY);

    const { result } = renderHook(() => useSetRateLimitRoute(), { wrapper: createWrapper() });
    result.current.mutate({ routeId: 'auth.login', limit: 3, ttl: 60000, enabled: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPut).toHaveBeenCalledWith('/admin/rate-limit/routes/auth.login', { limit: 3, ttl: 60000, enabled: true });
  });

  it('seeds the policy cache from the mutation result (no extra GET needed)', async () => {
    mockGet.mockResolvedValueOnce(POLICY);
    mockPut.mockResolvedValueOnce({ ...POLICY, enabled: false });

    // Render both hooks in one tree so they share the same QueryClient cache —
    // verifies the mutation's onSuccess replaces the cached policy in place.
    const { result } = renderHook(() => ({ policy: useRateLimitPolicy(), setEnabled: useSetRateLimitEnabled() }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.policy.isSuccess).toBe(true));
    expect(result.current.policy.data?.enabled).toBe(true);

    result.current.setEnabled.mutate(false);
    await waitFor(() => expect(result.current.setEnabled.isSuccess).toBe(true));

    await waitFor(() => expect(result.current.policy.data?.enabled).toBe(false));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
