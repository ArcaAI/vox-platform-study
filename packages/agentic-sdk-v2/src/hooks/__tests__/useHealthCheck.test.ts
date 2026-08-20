/**
 * useHealthCheck Hook Tests (consolidated health endpoint)
 *
 * The hook now makes 3 calls:
 *   1. GET /health       (API gateway health)
 *   2. GET /health/live  (API gateway liveness)
 *   3. GET /admin/health/services  (consolidated downstream service health)
 *
 * The /admin/health/services response contains per-service status for text, nlp, stt, guardrail.
 * The hook flattens this into the services map alongside api and apiLive.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHealthCheck } from '../useHealthCheck';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { HEALTH_ENDPOINTS, SERVICE_HEALTH_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const CONSOLIDATED_SERVICES_RESPONSE = {
  status: 'healthy',
  timestamp: '2026-03-02T00:00:00Z',
  services: {
    guardrail: { status: 'healthy', service: 'Guardrail', version: '1.0.0' },
    text: { status: 'healthy', service: 'Summarization', version: '2.0.0' },
    nlp: { status: 'healthy', service: 'Medical NLP', version: '1.0.0' },
    stt: { status: 'healthy', service: 'Speech to Text', version: '1.0.0' },
  },
};

describe('useHealthCheck', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockGet.mockReset();

    mockStore = {
      apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      logger: mockLogger,
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return idle status with empty services', () => {
      const { result } = renderHook(() => useHealthCheck());
      expect(result.current.status).toBe('idle');
      expect(result.current.services).toEqual({});
      expect(result.current.lastChecked).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('check', () => {
    it('should call exactly 3 endpoints (api, apiLive, services)', async () => {
      mockGet
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce(CONSOLIDATED_SERVICES_RESPONSE);
      const { result } = renderHook(() => useHealthCheck());

      await act(async () => {
        await result.current.check();
      });

      expect(mockGet).toHaveBeenCalledTimes(3);
      const calledEndpoints = mockGet.mock.calls.map((c: unknown[]) => c[0]);
      expect(calledEndpoints).toContain(HEALTH_ENDPOINTS.HEALTH);
      expect(calledEndpoints).toContain(HEALTH_ENDPOINTS.LIVE);
      expect(calledEndpoints).toContain(SERVICE_HEALTH_ENDPOINTS.SERVICES);
    });

    it('should aggregate to healthy when all succeed', async () => {
      mockGet
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce(CONSOLIDATED_SERVICES_RESPONSE);
      const { result } = renderHook(() => useHealthCheck());

      await act(async () => {
        await result.current.check();
      });

      expect(result.current.status).toBe('healthy');
      expect(result.current.lastChecked).toBeInstanceOf(Date);
    });

    it('should flatten consolidated response into services map', async () => {
      mockGet
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce(CONSOLIDATED_SERVICES_RESPONSE);
      const { result } = renderHook(() => useHealthCheck());

      await act(async () => {
        await result.current.check();
      });

      expect(result.current.services).toHaveProperty('api');
      expect(result.current.services).toHaveProperty('apiLive');
      expect(result.current.services).toHaveProperty('guardrail');
      expect(result.current.services).toHaveProperty('text');
      expect(result.current.services).toHaveProperty('nlp');
      expect(result.current.services).toHaveProperty('stt');
      expect(Object.keys(result.current.services)).toHaveLength(6);
    });

    it('should set status to degraded when some services are down', async () => {
      const degradedResponse = {
        ...CONSOLIDATED_SERVICES_RESPONSE,
        status: 'degraded',
        services: {
          ...CONSOLIDATED_SERVICES_RESPONSE.services,
          guardrail: { status: 'down', service: 'Guardrail' },
        },
      };
      mockGet.mockResolvedValueOnce({ status: 'healthy' }).mockResolvedValueOnce({ status: 'healthy' }).mockResolvedValueOnce(degradedResponse);
      const { result } = renderHook(() => useHealthCheck());

      await act(async () => {
        await result.current.check();
      });

      expect(result.current.status).toBe('degraded');
      expect(result.current.services.guardrail.status).toBe('down');
    });

    it('should set status to unhealthy when all fail', async () => {
      mockGet.mockRejectedValue(new Error('All down'));
      const { result } = renderHook(() => useHealthCheck());

      await act(async () => {
        await result.current.check();
      });

      expect(result.current.status).toBe('unhealthy');
    });

    it('should handle services endpoint failure gracefully', async () => {
      mockGet
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockRejectedValueOnce(new Error('Gateway timeout'));
      const { result } = renderHook(() => useHealthCheck());

      await act(async () => {
        await result.current.check();
      });

      expect(result.current.status).toBe('degraded');
      expect(result.current.services.api.status).toBe('healthy');
    });

    it('should throw when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useHealthCheck());

      await expect(
        act(async () => {
          await result.current.check();
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('startPolling / stopPolling', () => {
    it('should start polling at specified interval', async () => {
      mockGet.mockResolvedValue({ status: 'healthy', services: {} });
      const { result } = renderHook(() => useHealthCheck());

      act(() => {
        result.current.startPolling(5000);
      });

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(mockGet).toHaveBeenCalled();

      act(() => {
        result.current.stopPolling();
      });
    });

    it('should stop polling when stopPolling is called', async () => {
      mockGet.mockResolvedValue({ status: 'healthy', services: {} });
      const { result } = renderHook(() => useHealthCheck());

      act(() => {
        result.current.startPolling(5000);
      });
      act(() => {
        result.current.stopPolling();
      });

      mockGet.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('should clean up polling on unmount', async () => {
      mockGet.mockResolvedValue({ status: 'healthy', services: {} });
      const { result, unmount } = renderHook(() => useHealthCheck());

      act(() => {
        result.current.startPolling(5000);
      });
      unmount();

      mockGet.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('null logger', () => {
    it('should work when store.logger is null', async () => {
      mockStore.logger = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      mockGet
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce({ status: 'healthy' })
        .mockResolvedValueOnce(CONSOLIDATED_SERVICES_RESPONSE);
      const { result } = renderHook(() => useHealthCheck());

      await act(async () => {
        await result.current.check();
      });
      expect(result.current.status).toBe('healthy');
    });
  });
});
