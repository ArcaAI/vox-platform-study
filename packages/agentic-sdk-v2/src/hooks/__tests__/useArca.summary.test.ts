/**
 * @arcaai/vox - useArca Summary Tests (HOOK-03 + SUM-06)
 *
 * HOOK-03: loadDNAStyle not implemented — SummaryActions defines it but
 *          no hook implements it. No backend endpoint exists.
 * SUM-06: DNA endpoints have no backend — analyzeDNA always fails.
 *
 * These tests verify RUNTIME BEHAVIOR, not source-code strings.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import { SUMMARY_ENDPOINTS, CONTEXT_ENDPOINTS } from '../../core/constants';
import type { SummaryActions } from '../../types/summary';

// =============================================================================
// Store mock
// =============================================================================

const mockStoreDefaults = {
  consultation: null as Record<string, unknown> | null,
  relatedConsultations: [],
  sessionLoading: false,
  sessionError: null,
  isCapturing: false,
  isMuted: false,
  audioLevel: 0,
  isSpeaking: false,
  currentTranscript: '',
  audioPlugins: {
    noiseFilter: { isActive: false, isSupported: false },
    vad: { isActive: true, isSupported: true },
    stt: { isActive: true, isSupported: true, isProcessing: false },
  },
  audioError: null,
  contextItems: [],
  entities: [],
  sharedContext: [],
  contextLoading: false,
  contextError: null,
  summaries: [],
  dnaStyle: null,
  summaryGenerating: false,
  summaryError: null,
  initialized: true,
  globalError: null,
  apiClient: null as Record<string, unknown> | null,
  pluginManager: null as Record<string, unknown> | null,
  logger: null,
  setSessionLoading: vi.fn(),
  setSessionError: vi.fn(),
  setConsultation: vi.fn(),
  clearContext: vi.fn(),
  addContextItem: vi.fn(),
  setRelatedConsultations: vi.fn(),
  setIsCapturing: vi.fn(),
  setIsMuted: vi.fn(),
  setAudioLevel: vi.fn(),
  setIsSpeaking: vi.fn(),
  setCurrentTranscript: vi.fn(),
  setAudioPlugins: vi.fn(),
  setAudioError: vi.fn(),
  setContextLoading: vi.fn(),
  setContextError: vi.fn(),
  updateContextItem: vi.fn(),
  setSharedContext: vi.fn(),
  setEntities: vi.fn(),
  addEntities: vi.fn(),
  setSummaryGenerating: vi.fn(),
  setSummaryError: vi.fn(),
  addSummary: vi.fn(),
  setSummaries: vi.fn(),
  setDNAStyle: vi.fn(),
  reset: vi.fn(),
};

let currentMockStore = { ...mockStoreDefaults };

vi.mock('../../store', () => {
  return {
    useAgenticStore: vi.fn(() => currentMockStore),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
  };
});

// =============================================================================
// SUM-06 / HOOK-03: DNA methods — runtime behavior
// =============================================================================

describe('HOOK-03/SUM-06: DNA methods have no backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMockStore = {
      ...mockStoreDefaults,
      setSummaryGenerating: vi.fn(),
      setSummaryError: vi.fn(),
      addSummary: vi.fn(),
      setSummaries: vi.fn(),
    };
  });

  it('analyzeDNA should throw "not supported" at runtime', async () => {
    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.summary.analyzeDNA(['sample text']);
      })
    ).rejects.toThrow('DNA analysis is not supported');
  });

  it('analyzeDNA error message should mention "no backend endpoint"', async () => {
    const { result } = renderHook(() => useArca());

    try {
      await act(async () => {
        await result.current.summary.analyzeDNA(['sample']);
      });
    } catch (error) {
      expect((error as Error).message).toContain('no backend endpoint');
    }
  });

  it('analyzeDNA should throw even with empty array input', async () => {
    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.summary.analyzeDNA([]);
      })
    ).rejects.toThrow('DNA analysis is not supported');
  });

  it('UseArcaSummary should NOT expose loadDNAStyle', () => {
    const { result } = renderHook(() => useArca());
    const summary = result.current.summary as Record<string, unknown>;
    expect(summary.loadDNAStyle).toBeUndefined();
  });

  it('SummaryActions type should mark loadDNAStyle and analyzeDNA as deprecated', () => {
    const actions: Partial<SummaryActions> = {
      analyzeDNA: async () => { throw new Error('deprecated'); },
      loadDNAStyle: async () => { throw new Error('deprecated'); },
    };
    expect(actions.analyzeDNA).toBeDefined();
    expect(actions.loadDNAStyle).toBeDefined();
  });
});

// =============================================================================
// Summary interface shape
// =============================================================================

describe('UseArcaSummary interface shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMockStore = {
      ...mockStoreDefaults,
      setSummaryGenerating: vi.fn(),
      setSummaryError: vi.fn(),
      addSummary: vi.fn(),
      setSummaries: vi.fn(),
    };
  });

  it('should expose generatePreSummary as a function', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generatePreSummary).toBe('function');
  });

  it('should expose generateSummary as a function', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generateSummary).toBe('function');
  });

  it('should expose updateSummary as a function', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.updateSummary).toBe('function');
  });

  it('should expose loadSummaries as a function (HOOK-06)', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.loadSummaries).toBe('function');
  });

  it('should expose generateSummaryAsync as a function (SUM-01)', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generateSummaryAsync).toBe('function');
  });

  it('should expose generatePreSummaryAsync as a function (SUM-01)', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generatePreSummaryAsync).toBe('function');
  });

  it('should expose generateComprehensiveSummary as a function (SUM-02)', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.generateComprehensiveSummary).toBe('function');
  });

  it('should expose getLatestPreSummary as a function (SUM-03)', () => {
    const { result } = renderHook(() => useArca());
    expect(typeof result.current.summary.getLatestPreSummary).toBe('function');
  });

  it('should expose state: preSummary, summary, all, dnaStyle, isGenerating, error', () => {
    const { result } = renderHook(() => useArca());
    expect(result.current.summary).toHaveProperty('preSummary');
    expect(result.current.summary).toHaveProperty('summary');
    expect(result.current.summary).toHaveProperty('all');
    expect(result.current.summary).toHaveProperty('dnaStyle');
    expect(result.current.summary).toHaveProperty('isGenerating');
    expect(result.current.summary).toHaveProperty('error');
  });
});

// =============================================================================
// Summary action behaviors
// =============================================================================

describe('summary action behaviors', () => {
  const mockPost = vi.fn();
  const mockGet = vi.fn();
  const mockPatch = vi.fn();
  const consultationObj = { id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: vi.fn() },
      consultation: consultationObj,
      setSummaryGenerating: vi.fn(),
      setSummaryError: vi.fn(),
      addSummary: vi.fn(),
      setSummaries: vi.fn(),
    };
  });

  it('generateSummary should POST to SUMMARY_ENDPOINTS.GENERATE', async () => {
    const summaryResp = { id: 's-1', contextItemId: 'ctx-1', content: 'Summary', type: 'summary', llmProvider: 'openai', modelName: 'gpt-4', createdAt: '' };
    mockPost.mockResolvedValue(summaryResp);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.summary.generateSummary({ includeNER: true });
    });

    expect(mockPost).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.GENERATE('c-001'),
      { includeNER: true }
    );
    expect(currentMockStore.addSummary).toHaveBeenCalledWith(summaryResp);
  });

  it('generatePreSummary should POST to SUMMARY_ENDPOINTS.PRE_SUMMARY', async () => {
    const preSummaryResp = { id: 'ps-1', contextItemId: 'ctx-1', content: 'Pre-summary', type: 'pre_summary', llmProvider: 'openai', modelName: 'gpt-4', createdAt: '' };
    mockPost.mockResolvedValue(preSummaryResp);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.summary.generatePreSummary();
    });

    expect(mockPost).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.PRE_SUMMARY('c-001'),
      undefined
    );
  });

  it('loadSummaries should GET from SUMMARY_ENDPOINTS.LIST', async () => {
    mockGet.mockResolvedValue([]);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.summary.loadSummaries();
    });

    expect(mockGet).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.LIST('c-001')
    );
    expect(currentMockStore.setSummaries).toHaveBeenCalledWith([]);
  });

  it('updateSummary should PATCH the correct endpoint', async () => {
    mockPatch.mockResolvedValue(undefined);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.summary.updateSummary('s-1', 'Updated content');
    });

    expect(mockPatch).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.UPDATE('c-001', 's-1'),
      { content: 'Updated content' }
    );
  });

  it('generateSummaryAsync should POST to SUMMARY_ENDPOINTS.GENERATE_ASYNC', async () => {
    const jobResp = { jobId: 'job-1', status: 'pending', consultationId: 'c-001', createdAt: '' };
    mockPost.mockResolvedValue(jobResp);

    const { result } = renderHook(() => useArca());

    let job: unknown;
    await act(async () => {
      job = await result.current.summary.generateSummaryAsync();
    });

    expect(mockPost).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-001'),
      {}
    );
    expect(job).toEqual(jobResp);
  });

  it('generateComprehensiveSummary should POST to SUMMARY_ENDPOINTS.COMPREHENSIVE', async () => {
    const compResp = { id: 'comp-1', content: 'Comprehensive', consultationIds: ['c-001'], createdAt: '' };
    mockPost.mockResolvedValue(compResp);

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.summary.generateComprehensiveSummary();
    });

    expect(mockPost).toHaveBeenCalledWith(
      SUMMARY_ENDPOINTS.COMPREHENSIVE('c-001'),
      {}
    );
  });

  it('should throw "No active consultation" when consultation is null', async () => {
    currentMockStore = { ...currentMockStore, consultation: null };

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.summary.generateSummary();
      })
    ).rejects.toThrow('No active consultation');
  });

  it('should throw "SDK not initialized" when apiClient is null', async () => {
    currentMockStore = { ...currentMockStore, apiClient: null };

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => {
        await result.current.summary.generateSummary();
      })
    ).rejects.toThrow('SDK not initialized');
  });
});

// =============================================================================
// WS-5: Summary versioning enhancements
// =============================================================================

describe('WS-5: summary versioning enhancements', () => {
  const mockPost = vi.fn();
  const mockGet = vi.fn();
  const mockPatch = vi.fn();
  const consultationObj = { id: 'c-001', patientId: 'p-123', doctorId: 'd-456', appointmentDate: '2026-02-17', createdAt: '', updatedAt: '' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    currentMockStore = {
      ...mockStoreDefaults,
      apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: vi.fn() },
      consultation: consultationObj,
      setSummaryGenerating: vi.fn(),
      setSummaryError: vi.fn(),
      addSummary: vi.fn(),
      setSummaries: vi.fn(),
    };
  });

  describe('updateSummary with options', () => {
    it('should send UpdateSummaryOptions in the PATCH body', async () => {
      mockPatch.mockResolvedValue(undefined);
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.updateSummary('s-1', 'New content', {
          changeReason: 'Doctor correction',
          changeSource: 'doctor_edit',
        });
      });

      expect(mockPatch).toHaveBeenCalledWith(
        SUMMARY_ENDPOINTS.UPDATE('c-001', 's-1'),
        { content: 'New content', changeReason: 'Doctor correction', changeSource: 'doctor_edit' }
      );
    });

    it('should work without options (backwards compatible)', async () => {
      mockPatch.mockResolvedValue(undefined);
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.updateSummary('s-1', 'Updated');
      });

      expect(mockPatch).toHaveBeenCalledWith(
        SUMMARY_ENDPOINTS.UPDATE('c-001', 's-1'),
        { content: 'Updated' }
      );
    });
  });

  describe('getSummaryHistory', () => {
    it('should fetch version history from SUMMARY_ENDPOINTS.VERSIONS', async () => {
      const versions = [
        { id: 'v-1', contextItemId: 'ctx-1', versionNumber: 1, content: 'v1 content', createdAt: '' },
        { id: 'v-2', contextItemId: 'ctx-1', versionNumber: 2, content: 'v2 content', createdAt: '' },
      ];
      mockGet.mockResolvedValue(versions);
      const { result } = renderHook(() => useArca());

      let history: unknown;
      await act(async () => {
        history = await result.current.summary.getSummaryHistory('ctx-1');
      });

      expect(mockGet).toHaveBeenCalledWith(
        SUMMARY_ENDPOINTS.VERSIONS('c-001', 'ctx-1')
      );
      expect(history).toEqual(versions);
    });

    it('should throw when no active consultation', async () => {
      currentMockStore = { ...currentMockStore, consultation: null };
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.getSummaryHistory('ctx-1');
        })
      ).rejects.toThrow('No active consultation');
    });
  });

  describe('compareSummaryVersions', () => {
    it('should fetch two versions and return diff result', async () => {
      mockGet
        .mockResolvedValueOnce({ content: 'version one text' })
        .mockResolvedValueOnce({ content: 'version two text' });
      const { result } = renderHook(() => useArca());

      let diff: unknown;
      await act(async () => {
        diff = await result.current.summary.compareSummaryVersions('ctx-1', 1, 2);
      });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect((diff as any).changes).toBeDefined();
      expect((diff as any).stats).toBeDefined();
      expect((diff as any).patch).toBeDefined();
    });

    it('should throw when no active consultation', async () => {
      currentMockStore = { ...currentMockStore, consultation: null };
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.compareSummaryVersions('ctx-1', 1, 2);
        })
      ).rejects.toThrow('No active consultation');
    });
  });

  describe('updateSummary edge cases', () => {
    it('should set summaryError via store.setSummaryError on API failure and reset setSummaryGenerating to false', async () => {
      const apiError = new Error('Network error');
      mockPatch.mockRejectedValue(apiError);
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.updateSummary('s-1', 'Content');
        })
      ).rejects.toThrow('Network error');

      expect(currentMockStore.setSummaryError).toHaveBeenCalledWith(apiError);
      expect(currentMockStore.setSummaryGenerating).toHaveBeenCalledWith(false);
    });

    it('should throw "SDK not initialized" when apiClient is null', async () => {
      currentMockStore = { ...currentMockStore, apiClient: null };
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.updateSummary('s-1', 'Content');
        })
      ).rejects.toThrow('SDK not initialized');
    });

    it('should throw "No active consultation" when consultation is null', async () => {
      currentMockStore = { ...currentMockStore, consultation: null };
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.updateSummary('s-1', 'Content');
        })
      ).rejects.toThrow('No active consultation');
    });
  });

  describe('getSummaryHistory edge cases', () => {
    it('should throw "SDK not initialized" when apiClient is null', async () => {
      currentMockStore = { ...currentMockStore, apiClient: null };
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.getSummaryHistory('ctx-1');
        })
      ).rejects.toThrow('SDK not initialized');
    });

    it('should throw error on API failure', async () => {
      const apiError = new Error('API failure');
      mockGet.mockRejectedValue(apiError);
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.getSummaryHistory('ctx-1');
        })
      ).rejects.toThrow('API failure');
    });

    it('should handle empty array response correctly', async () => {
      mockGet.mockResolvedValue([]);
      const { result } = renderHook(() => useArca());

      let history: unknown;
      await act(async () => {
        history = await result.current.summary.getSummaryHistory('ctx-1');
      });

      expect(history).toEqual([]);
    });
  });

  describe('compareSummaryVersions edge cases', () => {
    it('should throw "SDK not initialized" when apiClient is null', async () => {
      currentMockStore = { ...currentMockStore, apiClient: null };
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.compareSummaryVersions('ctx-1', 1, 2);
        })
      ).rejects.toThrow('SDK not initialized');
    });

    it('should throw error on API failure when one of the parallel fetches fails', async () => {
      mockGet
        .mockResolvedValueOnce({ content: 'version one' })
        .mockRejectedValueOnce(new Error('Fetch failed'));
      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.compareSummaryVersions('ctx-1', 1, 2);
        })
      ).rejects.toThrow('Fetch failed');
    });

    it('should call CONTEXT_ENDPOINTS.VERSION with correct consultationId, contextItemId, and version numbers', async () => {
      mockGet
        .mockResolvedValueOnce({ content: 'v1' })
        .mockResolvedValueOnce({ content: 'v2' });
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.compareSummaryVersions('ctx-abc', 3, 7);
      });

      expect(mockGet).toHaveBeenNthCalledWith(
        1,
        CONTEXT_ENDPOINTS.VERSION('c-001', 'ctx-abc', 3)
      );
      expect(mockGet).toHaveBeenNthCalledWith(
        2,
        CONTEXT_ENDPOINTS.VERSION('c-001', 'ctx-abc', 7)
      );
    });

    it('should have additions > 0 and deletions > 0 when comparing "hello world" vs "hello universe"', async () => {
      mockGet
        .mockResolvedValueOnce({ content: 'hello world' })
        .mockResolvedValueOnce({ content: 'hello universe' });
      const { result } = renderHook(() => useArca());

      let diff: { stats: { additions: number; deletions: number } };
      await act(async () => {
        diff = await result.current.summary.compareSummaryVersions('ctx-1', 1, 2);
      });

      expect(diff.stats.additions).toBeGreaterThan(0);
      expect(diff.stats.deletions).toBeGreaterThan(0);
    });
  });
});
