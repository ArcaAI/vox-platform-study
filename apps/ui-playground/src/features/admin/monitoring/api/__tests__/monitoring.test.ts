import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useServiceSessions, useServiceUptime, useServicesHealth } from '../monitoring';

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

// ---------------------------------------------------------------------------
// OB-01 — System Health surfaces three EXISTING read-only endpoints that had
// no console consumer. The hooks must hit the exact backend paths.
// ---------------------------------------------------------------------------
describe('System Health (OB-01) monitoring API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useServiceUptime GETs /monitoring/uptime', async () => {
    mockGet.mockResolvedValueOnce({ services: {}, refreshedAt: '2026-06-06T00:00:00.000Z' });

    const { result } = renderHook(() => useServiceUptime(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/monitoring/uptime');
  });

  it('useServiceSessions GETs /monitoring/sessions', async () => {
    mockGet.mockResolvedValueOnce({ services: { tts: { active: 0 }, smr: { active: 0 } }, totalUsers: 0, refreshedAt: '2026-06-06T00:00:00.000Z' });

    const { result } = renderHook(() => useServiceSessions(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/monitoring/sessions');
  });

  it('useServicesHealth GETs /health/services (NOT a /monitoring path)', async () => {
    mockGet.mockResolvedValueOnce({ status: 'healthy', timestamp: '2026-06-06T00:00:00.000Z', services: {} });

    const { result } = renderHook(() => useServicesHealth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/health/services');
  });

  it('exposes the parsed payloads to consumers', async () => {
    mockGet.mockResolvedValueOnce({
      services: { stt: { status: 'healthy', uptime: 99.9, responseTime: 12, lastCheck: '2026-06-06T00:00:00.000Z', heartbeats: [] } },
      refreshedAt: '2026-06-06T00:00:00.000Z',
    });

    const { result } = renderHook(() => useServiceUptime(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.services.stt.uptime).toBe(99.9);
  });
});
