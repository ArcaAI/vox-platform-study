/**
 * useRateLimits Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRateLimits } from '../useRateLimits';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { RATE_LIMIT_ADMIN_ENDPOINTS } from '../../core/constants';
import type { RateLimitPolicy } from '../../types/ops-admin';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const POLICY: RateLimitPolicy = {
  enabled: false,
  enabledSource: 'db',
  tiers: [
    { tier: 'default', limit: 100, ttl: 60000, limitSource: 'default', ttlSource: 'default' },
    { tier: 'strict', limit: 10, ttl: 60000, limitSource: 'db', ttlSource: 'default' },
  ],
  routes: [
    {
      routeId: 'auth.login',
      controller: 'AuthController',
      handler: 'login',
      description: 'Login',
      tier: 'default',
      limit: 5,
      ttl: 60000,
      enabled: true,
      limitSource: 'code',
      ttlSource: 'code',
    },
  ],
};

describe('useRateLimits', () => {
  const mockGet = vi.fn();
  const mockPut = vi.fn();

  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    (useAgenticStore as any).mockReturnValue({
      apiClient: { get: mockGet, put: mockPut },
      logger: createMockLogger(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts with a null policy and no error', () => {
    const { result } = renderHook(() => useRateLimits());
    expect(result.current.policy).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('refresh() GETs the policy endpoint and stores the result', async () => {
    mockGet.mockResolvedValue(POLICY);
    const { result } = renderHook(() => useRateLimits());

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGet).toHaveBeenCalledWith(RATE_LIMIT_ADMIN_ENDPOINTS.POLICY);
    expect(result.current.policy).toEqual(POLICY);
  });

  it('setEnabled() PUTs the kill-switch and replaces the policy with the response', async () => {
    const enabledPolicy = { ...POLICY, enabled: true };
    mockPut.mockResolvedValue(enabledPolicy);
    const { result } = renderHook(() => useRateLimits());

    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(mockPut).toHaveBeenCalledWith(RATE_LIMIT_ADMIN_ENDPOINTS.SET_ENABLED, { enabled: true });
    expect(result.current.policy).toEqual(enabledPolicy);
  });

  it('setTier() PUTs the tier endpoint with only the supplied fields', async () => {
    mockPut.mockResolvedValue(POLICY);
    const { result } = renderHook(() => useRateLimits());

    await act(async () => {
      await result.current.setTier('strict', { limit: 25 });
    });

    expect(mockPut).toHaveBeenCalledWith(RATE_LIMIT_ADMIN_ENDPOINTS.SET_TIER('strict'), { limit: 25 });
    expect(result.current.policy).toEqual(POLICY);
  });

  it('setRoute() PUTs the route override endpoint', async () => {
    mockPut.mockResolvedValue(POLICY);
    const { result } = renderHook(() => useRateLimits());

    await act(async () => {
      await result.current.setRoute('auth.login', { enabled: false });
    });

    expect(mockPut).toHaveBeenCalledWith(RATE_LIMIT_ADMIN_ENDPOINTS.SET_ROUTE('auth.login'), { enabled: false });
  });

  it('surfaces errors and clears loading', async () => {
    mockGet.mockRejectedValue(new Error('Forbidden'));
    const { result } = renderHook(() => useRateLimits());

    await act(async () => {
      try {
        await result.current.refresh();
      } catch {
        /* expected */
      }
    });

    expect(result.current.error?.message).toBe('Forbidden');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.policy).toBeNull();
  });
});
