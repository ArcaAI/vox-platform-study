/**
 * useArca Hook Tests — Workstream H: listConsultations
 *
 * Tests for the new listConsultations method on useArca().session
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { CONSULTATION_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return {
    ...actual,
    useAgenticStore: vi.fn(),
  };
});

function createDefaultMockStore(overrides: Record<string, any> = {}) {
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockPatch = vi.fn();
  const mockDelete = vi.fn();
  const mockLogger = createMockLogger();

  return {
    apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete },
    logger: mockLogger,
    consultation: null,
    relatedConsultations: [],
    sessionLoading: false,
    sessionError: null,
    context: [],
    contextItems: [],
    contextLoading: false,
    contextError: null,
    summaries: [],
    summaryLoading: false,
    summaryError: null,
    entities: [],
    entityLoading: false,
    entityError: null,
    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    isSpeaking: false,
    currentTranscript: '',
    audioError: null,
    audioPlugins: {
      noiseFilter: { isSupported: false },
      vad: { isSupported: false },
      stt: { isSupported: false },
    },
    config: null,
    isAudioSource: false,
    transcriptionPipelineState: { status: 'idle' },
    knowledgePipelineState: { status: 'idle' },
    pluginManager: null,
    setConsultation: vi.fn(),
    setRelatedConsultations: vi.fn(),
    setSessionLoading: vi.fn(),
    setSessionError: vi.fn(),
    setContext: vi.fn(),
    addContextItem: vi.fn(),
    setContextLoading: vi.fn(),
    setContextError: vi.fn(),
    setSummaries: vi.fn(),
    setSummaryLoading: vi.fn(),
    setSummaryError: vi.fn(),
    setEntities: vi.fn(),
    setEntityLoading: vi.fn(),
    setEntityError: vi.fn(),
    setAudioLanguage: vi.fn(),
    ...overrides,
    mockGet,
    mockPost,
    mockPatch,
    mockDelete,
  };
}

describe('useArca — WS-H: listConsultations', () => {
  let mockStore: ReturnType<typeof createDefaultMockStore>;

  beforeEach(() => {
    mockStore = createDefaultMockStore();
    (useAgenticStore as any).mockImplementation((selector?: any) => {
      if (typeof selector === 'function') return selector(mockStore);
      return mockStore;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('session.listConsultations', () => {
    it('should be a function on session', () => {
      const { result } = renderHook(() => useArca());
      expect(typeof result.current.session.listConsultations).toBe('function');
    });

    it('should GET from CONSULTATION_ENDPOINTS.LIST with default params', async () => {
      const paginatedResp = {
        data: [{ id: 'c-1', patientId: 'p-1', doctorId: 'd-1', appointmentDate: '2025-01-01', createdAt: '', updatedAt: '' }],
        total: 1,
        page: 1,
        limit: 20,
      };
      mockStore.mockGet.mockResolvedValue(paginatedResp);
      const { result } = renderHook(() => useArca());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.session.listConsultations();
      });

      expect(mockStore.mockGet).toHaveBeenCalledWith(expect.stringContaining(CONSULTATION_ENDPOINTS.LIST));
      expect(resp).toEqual(paginatedResp);
    });

    it('should normalize API `count` to `total` so SDK pagination works past page 1 (EU-03)', async () => {
      // The API returns `{ count }`; the SDK pagination contract expects `total`.
      mockStore.mockGet.mockResolvedValue({
        data: [{ id: 'c-1', patientId: 'p-1', doctorId: 'd-1', appointmentDate: '2025-01-01', createdAt: '', updatedAt: '' }],
        count: 42,
        page: 2,
        limit: 20,
      });
      const { result } = renderHook(() => useArca());

      let resp: any;
      await act(async () => {
        resp = await result.current.session.listConsultations({ page: 2 });
      });

      expect(resp.total).toBe(42);
      expect(resp.page).toBe(2);
      expect(resp.limit).toBe(20);
      expect(resp.data).toHaveLength(1);
      expect(resp.count).toBeUndefined();
    });

    it('should pass filters as query params', async () => {
      const paginatedResp = { data: [], total: 0, page: 1, limit: 20 };
      mockStore.mockGet.mockResolvedValue(paginatedResp);
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.session.listConsultations({
          page: 2,
          limit: 10,
          doctorId: 'doc-1',
          hasSummary: true,
          departmentId: 'dept-1',
        });
      });

      const calledUrl = mockStore.mockGet.mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=10');
      expect(calledUrl).toContain('doctorId=doc-1');
      expect(calledUrl).toContain('hasSummary=true');
      expect(calledUrl).toContain('departmentId=dept-1');
    });

    it('should throw when apiClient is not available', async () => {
      (mockStore as { apiClient: unknown }).apiClient = null;
      (useAgenticStore as any).mockImplementation((selector?: any) => {
        if (typeof selector === 'function') return selector(mockStore);
        return mockStore;
      });
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.session.listConsultations();
        }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('should call setSessionError and rethrow on failure', async () => {
      const error = new Error('Network error');
      mockStore.mockGet.mockRejectedValue(error);
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.session.listConsultations();
        }),
      ).rejects.toThrow('Network error');

      expect(mockStore.setSessionError).toHaveBeenCalledWith(error);
    });
  });
});
