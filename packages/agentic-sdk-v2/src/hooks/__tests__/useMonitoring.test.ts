/**
 * useMonitoring Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMonitoring } from '../useMonitoring';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { MONITORING_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useMonitoring', () => {
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
    it('should return null uptime, null sessions, not loading', () => {
      const { result } = renderHook(() => useMonitoring());
      expect(result.current.uptime).toBeNull();
      expect(result.current.sessions).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('refresh', () => {
    it('should fetch uptime and sessions in parallel and update state', async () => {
      const uptimeData = [
        { service: 'stt', status: 'up', uptimeSeconds: 3600 },
        { service: 'smr', status: 'up', uptimeSeconds: 7200 },
      ];
      // Real backend SessionsResponse shape (per-service active + totalUsers).
      const sessionsData = {
        services: { smr: { active: 2 }, stt: { active: 5 }, nlp: { active: 1 }, guardrail: { active: 0 }, harness: { active: 0 } },
        totalUsers: 4,
        refreshedAt: '2026-07-01T00:00:00.000Z',
      };
      mockGet.mockResolvedValueOnce(uptimeData).mockResolvedValueOnce(sessionsData);
      const { result } = renderHook(() => useMonitoring());

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockGet).toHaveBeenCalledWith(MONITORING_ENDPOINTS.UPTIME);
      expect(mockGet).toHaveBeenCalledWith(MONITORING_ENDPOINTS.SESSIONS);
      expect(result.current.uptime).toEqual(uptimeData);
      // activeSessions = stt.active (5); processingJobs = smr+nlp+guardrail+harness (3); total = 8.
      expect(result.current.sessions).toMatchObject({ activeSessions: 5, processingJobs: 3, active: 5, total: 8, totalUsers: 4 });
    });

    it('should set error on failure', async () => {
      mockGet.mockRejectedValue(new Error('Monitoring unavailable'));
      const { result } = renderHook(() => useMonitoring());

      await act(async () => {
        try {
          await result.current.refresh();
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Monitoring unavailable');
      expect(result.current.isLoading).toBe(false);
    });

    it('should extract uptime array from paginated wrapper response', async () => {
      const uptimeItems = [{ service: 'stt', status: 'up', uptimeSeconds: 3600 }];
      const sessionsData = { active: 5, total: 100 };
      mockGet.mockResolvedValueOnce({ data: uptimeItems, count: 1 }).mockResolvedValueOnce(sessionsData);
      const { result } = renderHook(() => useMonitoring());

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.uptime).toEqual(uptimeItems);
      expect(Array.isArray(result.current.uptime)).toBe(true);
    });
  });

  describe('SessionCounts type contract (backend SessionsResponse)', () => {
    it('derives activeSessions (stt) + processingJobs (smr+nlp+guardrail+harness) from the services map', async () => {
      const uptimeData = [{ service: 'stt', status: 'up', uptimeSeconds: 3600 }];
      const sessionsData = {
        services: { smr: { active: 1 }, stt: { active: 2 }, nlp: { active: 1 }, guardrail: { active: 1 }, harness: { active: 0 } },
        totalUsers: 6,
        refreshedAt: '2026-07-01T00:00:00.000Z',
      };
      mockGet.mockResolvedValueOnce(uptimeData).mockResolvedValueOnce(sessionsData);
      const { result } = renderHook(() => useMonitoring());

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.sessions?.activeSessions).toBe(2);
      expect(result.current.sessions?.processingJobs).toBe(3);
      expect(result.current.sessions?.services.stt.active).toBe(2);
      expect(result.current.sessions?.totalUsers).toBe(6);
    });

    it('defaults to all-zero when the services map is absent/malformed', async () => {
      const uptimeData = [{ service: 'stt', status: 'up', uptimeSeconds: 3600 }];
      const sessionsData = { totalUsers: 0 };
      mockGet.mockResolvedValueOnce(uptimeData).mockResolvedValueOnce(sessionsData);
      const { result } = renderHook(() => useMonitoring());

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.sessions?.activeSessions).toBe(0);
      expect(result.current.sessions?.processingJobs).toBe(0);
      expect(result.current.sessions?.total).toBe(0);
    });
  });

  describe('getServiceUptime', () => {
    it('should GET from MONITORING_ENDPOINTS.SERVICE_UPTIME', async () => {
      const serviceData = { service: 'stt', status: 'up', uptimeSeconds: 3600 };
      mockGet.mockResolvedValue(serviceData);
      const { result } = renderHook(() => useMonitoring());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getServiceUptime('stt');
      });

      expect(mockGet).toHaveBeenCalledWith(MONITORING_ENDPOINTS.SERVICE_UPTIME('stt'));
      expect(resp).toEqual(serviceData);
    });
  });

  describe('getHeartbeats', () => {
    it('should GET from MONITORING_ENDPOINTS.HEARTBEATS', async () => {
      const heartbeats = [{ timestamp: '2026-02-20T10:00:00Z', status: 'up', latencyMs: 50 }];
      mockGet.mockResolvedValue(heartbeats);
      const { result } = renderHook(() => useMonitoring());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getHeartbeats('stt');
      });

      expect(mockGet).toHaveBeenCalledWith(MONITORING_ENDPOINTS.HEARTBEATS('stt'));
      expect(resp).toEqual(heartbeats);
    });
  });

  describe('getHeartbeats paginated', () => {
    it('should extract array from paginated wrapper response', async () => {
      const items = [{ timestamp: '2026-02-20T10:00:00Z', status: 'up', latencyMs: 50 }];
      mockGet.mockResolvedValue({ data: items, count: 1 });
      const { result } = renderHook(() => useMonitoring());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getHeartbeats('stt');
      });

      expect(resp).toEqual(items);
      expect(Array.isArray(resp)).toBe(true);
    });
  });

  describe('SDK not initialized', () => {
    it('should throw when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useMonitoring());

      await expect(
        act(async () => {
          await result.current.refresh();
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('error clearing', () => {
    it('should clear error on subsequent success', async () => {
      const uptimeData = [{ service: 'stt', status: 'up', uptimeSeconds: 100 }];
      const sessionsData = { active: 1, total: 10 };
      mockGet
        .mockRejectedValueOnce(new Error('Fail'))
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce(uptimeData)
        .mockResolvedValueOnce(sessionsData);
      const { result } = renderHook(() => useMonitoring());

      await act(async () => {
        try {
          await result.current.refresh();
        } catch {
          /* expected */
        }
      });
      expect(result.current.error?.message).toBe('Fail');

      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.error).toBeNull();
    });
  });

  describe('null logger', () => {
    it('should work when store.logger is null', async () => {
      mockStore.logger = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const uptimeData = [{ service: 'stt', status: 'up', uptimeSeconds: 100 }];
      const sessionsData = { active: 1, total: 10 };
      mockGet.mockResolvedValueOnce(uptimeData).mockResolvedValueOnce(sessionsData);
      const { result } = renderHook(() => useMonitoring());

      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.uptime).toEqual(uptimeData);
    });
  });
});
