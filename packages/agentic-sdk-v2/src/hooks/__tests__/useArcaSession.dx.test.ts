/**
 * @arcaai/vox - useArcaSession DX Polish Tests (Stream F)
 *
 * TDD tests for F7: HOOK-06 — Summaries fetched on consultation load
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSession } from '../useArcaSession';

// Mock dependencies
vi.mock('../../core/SimpleCrossTabSync', () => ({
  SimpleCrossTabSync: vi.fn(),
  createCrossTabSync: vi.fn(() => ({
    onContextAdded: vi.fn(),
    broadcastContext: vi.fn(),
    close: vi.fn(),
  })),
}));

const mockStoreDefaults = {
  consultation: null as Record<string, unknown> | null,
  contextItems: [],
  sessionLoading: false,
  sessionError: null,
  summaries: [],
  apiClient: null as Record<string, unknown> | null,
  logger: null,
  setSessionLoading: vi.fn(),
  setSessionError: vi.fn(),
  setConsultation: vi.fn(),
  clearContext: vi.fn(),
  addContextItem: vi.fn(),
  setSharedContext: vi.fn(),
  setSummaries: vi.fn(),
};

let currentMockStore = { ...mockStoreDefaults };

vi.mock('../../store', () => {
  return {
    useAgenticStore: vi.fn(() => currentMockStore),
  };
});

/**
 * Factory for complete Consultation mock matching the real interface.
 * Prevents anti-pattern #4 (incomplete mocks) by including all required fields.
 */
function createMockConsultation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'consult-100',
    patientId: 'patient-001',
    doctorId: 'doctor-001',
    doctorName: 'Dr. Smith',
    appointmentDate: '2026-02-17',
    department: 'Cardiology',
    metadata: {},
    contextItems: [],
    createdAt: '2026-02-17T08:00:00Z',
    updatedAt: '2026-02-17T08:00:00Z',
    isNew: false,
    ...overrides,
  };
}

describe('useArcaSession DX Polish (Stream F)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMockStore = {
      ...mockStoreDefaults,
      setSessionLoading: vi.fn(),
      setSessionError: vi.fn(),
      setConsultation: vi.fn(),
      clearContext: vi.fn(),
      addContextItem: vi.fn(),
      setSharedContext: vi.fn(),
      setSummaries: vi.fn(),
    };
  });

  describe('F7: Load summaries on consultation load (HOOK-06)', () => {
    it('should expose loadSummaries method', () => {
      const { result } = renderHook(() => useArcaSession());
      expect(result.current).toHaveProperty('loadSummaries');
      expect(typeof result.current.loadSummaries).toBe('function');
    });

    it('should fetch summaries from backend via GET /consultations/:id/summary', async () => {
      const summaries = [
        { id: 's1', type: 'summary', content: 'Test summary' },
      ];
      const mockGet = vi.fn().mockResolvedValue(summaries);
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet, post: vi.fn() },
        consultation: createMockConsultation({ id: 'consult-100' }),
        setSummaries,
      };

      const { result } = renderHook(() => useArcaSession());

      await act(async () => {
        await result.current.loadSummaries();
      });

      // HOOK-06 fix: must use SUMMARY_ENDPOINTS.LIST (GET), not GENERATE (POST)
      expect(mockGet).toHaveBeenCalledWith('/consultations/consult-100/summary');
      expect(setSummaries).toHaveBeenCalledWith(summaries);
      // Verify it's a GET (the mock), not POST
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should throw if no consultation open', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: vi.fn() },
        consultation: null,
      };

      const { result } = renderHook(() => useArcaSession());

      await expect(
        act(async () => {
          await result.current.loadSummaries();
        })
      ).rejects.toThrow('No consultation open');
    });

    it('should throw if SDK not initialized (apiClient null)', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: null,
        consultation: createMockConsultation({ id: 'consult-200' }),
      };

      const { result } = renderHook(() => useArcaSession());

      await expect(
        act(async () => {
          await result.current.loadSummaries();
        })
      ).rejects.toThrow('SDK not initialized');
    });

    it('should return the summaries array from the API', async () => {
      const summaries = [
        { id: 's1', type: 'summary', content: 'Summary A' },
        { id: 's2', type: 'pre_summary', content: 'Pre-summary B' },
      ];
      const mockGet = vi.fn().mockResolvedValue(summaries);
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet, post: vi.fn() },
        consultation: createMockConsultation({ id: 'consult-300' }),
        setSummaries,
      };

      const { result } = renderHook(() => useArcaSession());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.loadSummaries();
      });

      expect(returned).toBe(summaries);
      expect(setSummaries).toHaveBeenCalledWith(summaries);
    });

    it('should handle empty summaries from backend', async () => {
      const mockGet = vi.fn().mockResolvedValue([]);
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet, post: vi.fn() },
        consultation: createMockConsultation({ id: 'consult-400' }),
        setSummaries,
      };

      const { result } = renderHook(() => useArcaSession());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.loadSummaries();
      });

      expect(returned).toEqual([]);
      expect(setSummaries).toHaveBeenCalledWith([]);
    });

    it('should handle API returning null gracefully', async () => {
      const mockGet = vi.fn().mockResolvedValue(null);
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet, post: vi.fn() },
        consultation: createMockConsultation({ id: 'consult-null' }),
        setSummaries,
      };

      const { result } = renderHook(() => useArcaSession());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.loadSummaries();
      });

      // null is passed through — setSummaries should still be called
      // (the store/UI handles the null-safety)
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(setSummaries).toHaveBeenCalledWith(null);
      expect(returned).toBeNull();
    });

    it('should propagate API errors without calling setSummaries', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Service unavailable'));
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet, post: vi.fn() },
        consultation: createMockConsultation({ id: 'consult-500' }),
        setSummaries,
      };

      const { result } = renderHook(() => useArcaSession());

      await expect(
        act(async () => {
          await result.current.loadSummaries();
        })
      ).rejects.toThrow('Service unavailable');

      expect(setSummaries).not.toHaveBeenCalled();
    });
  });
});
