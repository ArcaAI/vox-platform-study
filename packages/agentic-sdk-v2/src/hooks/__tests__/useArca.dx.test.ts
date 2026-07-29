/**
 * @arcaai/vox - useArca DX Polish Tests (Stream F)
 *
 * TDD tests for:
 * - F1: ASR-L-01/HOOK-05 — toggleSTT/toggleVAD exposed on audio interface
 * - F5: SES-07 — Dedicated transcription/case-note fetch methods
 * - F7: HOOK-06 — Summaries fetched on consultation load
 * - F8: HOOK-07 — Retry wrapper using isRetriableError
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import { useAgenticStore } from '../../store';

// Mock the store — use vi.mocked for ESM compatibility
const mockStoreDefaults = {
  consultation: null,
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
  addContextItem: vi.fn(),
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
// F1: ASR-L-01/HOOK-05 — toggleSTT and toggleVAD on audio interface
// =============================================================================

describe('Stream F: DX Polish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMockStore = {
      ...mockStoreDefaults,
      setSessionLoading: vi.fn(),
      setSessionError: vi.fn(),
      setConsultation: vi.fn(),
      clearContext: vi.fn(),
      setIsCapturing: vi.fn(),
      setIsMuted: vi.fn(),
      setAudioLevel: vi.fn(),
      setIsSpeaking: vi.fn(),
      setCurrentTranscript: vi.fn(),
      setAudioPlugins: vi.fn(),
      setAudioError: vi.fn(),
      setContextLoading: vi.fn(),
      setContextError: vi.fn(),
      addContextItem: vi.fn(),
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
  });

  describe('F1: toggleSTT and toggleVAD (ASR-L-01/HOOK-05)', () => {
    it('should expose toggleSTT on the audio interface', () => {
      const { result } = renderHook(() => useArca());
      expect(result.current.audio).toHaveProperty('toggleSTT');
      expect(typeof result.current.audio.toggleSTT).toBe('function');
    });

    it('should expose toggleVAD on the audio interface', () => {
      const { result } = renderHook(() => useArca());
      expect(result.current.audio).toHaveProperty('toggleVAD');
      expect(typeof result.current.audio.toggleVAD).toBe('function');
    });

    it('toggleSTT should call pluginManager.setEnabled("stt", ...)', async () => {
      const mockSetEnabled = vi.fn();
      const mockGetStates = vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: false, isSupported: false },
        stt: { isActive: true, isSupported: true, isProcessing: false },
      }));

      currentMockStore = {
        ...currentMockStore,
        pluginManager: {
          setEnabled: mockSetEnabled,
          getStates: mockGetStates,
        },
      };

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleSTT(false);
      });

      expect(mockSetEnabled).toHaveBeenCalledWith('stt', false);
    });

    it('toggleVAD should call pluginManager.setEnabled("vad", ...)', async () => {
      const mockSetEnabled = vi.fn();
      const mockGetStates = vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: true, isSupported: true },
        stt: { isActive: false, isSupported: false, isProcessing: false },
      }));

      currentMockStore = {
        ...currentMockStore,
        pluginManager: {
          setEnabled: mockSetEnabled,
          getStates: mockGetStates,
        },
      };

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleVAD(false);
      });

      expect(mockSetEnabled).toHaveBeenCalledWith('vad', false);
    });

    it('toggleSTT should toggle current state when no argument provided', async () => {
      const mockSetEnabled = vi.fn();
      const mockGetStates = vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: false, isSupported: false },
        stt: { isActive: true, isSupported: true, isProcessing: false },
      }));

      currentMockStore = {
        ...currentMockStore,
        pluginManager: {
          setEnabled: mockSetEnabled,
          getStates: mockGetStates,
        },
      };

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleSTT();
      });

      // Active is true, so toggle should set to false
      expect(mockSetEnabled).toHaveBeenCalledWith('stt', false);
    });

    it('toggleSTT should update audio plugin states after toggle', async () => {
      const setAudioPlugins = vi.fn();
      const newStates = {
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: false, isSupported: false },
        stt: { isActive: false, isSupported: true, isProcessing: false },
      };
      const mockGetStates = vi.fn(() => newStates);

      currentMockStore = {
        ...currentMockStore,
        pluginManager: {
          setEnabled: vi.fn(),
          getStates: mockGetStates,
        },
        setAudioPlugins,
      };

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleSTT(false);
      });

      expect(setAudioPlugins).toHaveBeenCalledWith(newStates);
    });

    it('toggleSTT should be a no-op when pluginManager is null', async () => {
      currentMockStore = {
        ...currentMockStore,
        pluginManager: null,
      };

      const { result } = renderHook(() => useArca());

      // Should not throw
      await act(async () => {
        await result.current.audio.toggleSTT(true);
      });

      // No setAudioPlugins call since pluginManager is null
      expect(currentMockStore.setAudioPlugins).not.toHaveBeenCalled();
    });

    it('toggleVAD should be a no-op when pluginManager is null', async () => {
      currentMockStore = {
        ...currentMockStore,
        pluginManager: null,
      };

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleVAD(false);
      });

      expect(currentMockStore.setAudioPlugins).not.toHaveBeenCalled();
    });

    it('toggleVAD should toggle inactive VAD to active when no argument provided', async () => {
      const mockSetEnabled = vi.fn();
      const mockGetStates = vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: false },
        vad: { isActive: false, isSupported: true },
        stt: { isActive: false, isSupported: false, isProcessing: false },
      }));

      currentMockStore = {
        ...currentMockStore,
        pluginManager: {
          setEnabled: mockSetEnabled,
          getStates: mockGetStates,
        },
      };

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleVAD();
      });

      // VAD is currently inactive, so toggle should set to true
      expect(mockSetEnabled).toHaveBeenCalledWith('vad', true);
    });
  });

  // =============================================================================
  // F5: SES-07 — Dedicated transcription/case-note fetch methods
  // =============================================================================

  describe('F5: Dedicated transcription/case-note fetch (SES-07)', () => {
    it('should expose fetchTranscriptions on context interface', () => {
      const { result } = renderHook(() => useArca());
      expect(result.current.context).toHaveProperty('fetchTranscriptions');
      expect(typeof result.current.context.fetchTranscriptions).toBe('function');
    });

    it('should expose fetchCaseNotes on context interface', () => {
      const { result } = renderHook(() => useArca());
      expect(result.current.context).toHaveProperty('fetchCaseNotes');
      expect(typeof result.current.context.fetchCaseNotes).toBe('function');
    });

    it('fetchTranscriptions should call GET /consultations/:id/context/transcriptions', async () => {
      const mockGet = vi.fn().mockResolvedValue([{ id: 't1', type: 'transcription', content: 'Hello' }]);

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-1' } as any,
      };

      const { result } = renderHook(() => useArca());

      let items: unknown;
      await act(async () => {
        items = await result.current.context.fetchTranscriptions();
      });

      expect(mockGet).toHaveBeenCalledWith('/consultations/consult-1/context/transcriptions');
      expect(items).toHaveLength(1);
    });

    it('fetchCaseNotes should call GET /consultations/:id/context/case-notes', async () => {
      const mockGet = vi.fn().mockResolvedValue([{ id: 'cn1', type: 'case_note', content: 'Patient note' }]);

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-2' } as any,
      };

      const { result } = renderHook(() => useArca());

      let items: unknown;
      await act(async () => {
        items = await result.current.context.fetchCaseNotes();
      });

      expect(mockGet).toHaveBeenCalledWith('/consultations/consult-2/context/case-notes');
      expect(items).toHaveLength(1);
    });

    it('fetchTranscriptions should throw if no consultation open', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: vi.fn() },
        consultation: null,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.context.fetchTranscriptions();
        }),
      ).rejects.toThrow('No active consultation');
    });

    it('fetchCaseNotes should throw if no consultation open', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: vi.fn() },
        consultation: null,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.context.fetchCaseNotes();
        }),
      ).rejects.toThrow('No active consultation');
    });

    it('fetchTranscriptions should throw if SDK not initialized (apiClient null)', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: null,
        consultation: { id: 'consult-99' } as any,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.context.fetchTranscriptions();
        }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('fetchCaseNotes should throw if SDK not initialized (apiClient null)', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: null,
        consultation: { id: 'consult-99' } as any,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.context.fetchCaseNotes();
        }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('fetchTranscriptions should return empty array when backend returns none', async () => {
      const mockGet = vi.fn().mockResolvedValue([]);

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-empty' } as any,
      };

      const { result } = renderHook(() => useArca());

      let items: unknown;
      await act(async () => {
        items = await result.current.context.fetchTranscriptions();
      });

      expect(mockGet).toHaveBeenCalledWith('/consultations/consult-empty/context/transcriptions');
      expect(items).toEqual([]);
    });

    it('fetchCaseNotes should return empty array when backend returns none', async () => {
      const mockGet = vi.fn().mockResolvedValue([]);

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-empty' } as any,
      };

      const { result } = renderHook(() => useArca());

      let items: unknown;
      await act(async () => {
        items = await result.current.context.fetchCaseNotes();
      });

      expect(mockGet).toHaveBeenCalledWith('/consultations/consult-empty/context/case-notes');
      expect(items).toEqual([]);
    });

    it('fetchTranscriptions should propagate API errors', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Server error'));

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-err' } as any,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.context.fetchTranscriptions();
        }),
      ).rejects.toThrow('Server error');
    });
  });

  // =============================================================================
  // F7: HOOK-06 — Summaries fetched on consultation load
  // =============================================================================

  describe('F7: Load summaries on consultation open (HOOK-06)', () => {
    it('should expose loadSummaries on summary interface', () => {
      const { result } = renderHook(() => useArca());
      expect(result.current.summary).toHaveProperty('loadSummaries');
      expect(typeof result.current.summary.loadSummaries).toBe('function');
    });

    it('loadSummaries should fetch from GET /consultations/:id/summary', async () => {
      const summaries = [{ id: 's1', type: 'summary', content: 'Summary text' }];
      const mockGet = vi.fn().mockResolvedValue(summaries);
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-sum' } as any,
        setSummaries,
      };

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.summary.loadSummaries();
      });

      expect(mockGet).toHaveBeenCalledWith('/consultations/consult-sum/summary');
      expect(setSummaries).toHaveBeenCalledWith(summaries);
    });

    it('loadSummaries should throw if no consultation open', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: vi.fn() },
        consultation: null,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.loadSummaries();
        }),
      ).rejects.toThrow('No active consultation');
    });

    it('loadSummaries should throw if SDK not initialized (apiClient null)', async () => {
      currentMockStore = {
        ...currentMockStore,
        apiClient: null,
        consultation: { id: 'consult-x' } as any,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.loadSummaries();
        }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('loadSummaries should return the same array it sets in the store', async () => {
      const summaries = [
        { id: 's1', type: 'summary', content: 'A' },
        { id: 's2', type: 'pre_summary', content: 'B' },
      ];
      const mockGet = vi.fn().mockResolvedValue(summaries);
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-ret' } as any,
        setSummaries,
      };

      const { result } = renderHook(() => useArca());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.summary.loadSummaries();
      });

      expect(returned).toBe(summaries);
      expect(setSummaries).toHaveBeenCalledWith(summaries);
    });

    it('loadSummaries should handle empty summaries array', async () => {
      const mockGet = vi.fn().mockResolvedValue([]);
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-no-sum' } as any,
        setSummaries,
      };

      const { result } = renderHook(() => useArca());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.summary.loadSummaries();
      });

      expect(returned).toEqual([]);
      expect(setSummaries).toHaveBeenCalledWith([]);
    });

    it('loadSummaries should propagate API errors without calling setSummaries', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('500 Internal'));
      const setSummaries = vi.fn();

      currentMockStore = {
        ...currentMockStore,
        apiClient: { get: mockGet },
        consultation: { id: 'consult-err' } as any,
        setSummaries,
      };

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.summary.loadSummaries();
        }),
      ).rejects.toThrow('500 Internal');

      expect(setSummaries).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // F8: HOOK-07 — Retry wrapper
  // =============================================================================

  describe('F8: Retry logic (HOOK-07)', () => {
    it('should expose withRetry utility on the return interface', () => {
      const { result } = renderHook(() => useArca());
      expect(result.current).toHaveProperty('withRetry');
      expect(typeof result.current.withRetry).toBe('function');
    });

    it('withRetry should retry on retriable errors', async () => {
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount < 3) {
          throw new TypeError('Failed to fetch');
        }
        return 'success';
      });

      const { result } = renderHook(() => useArca());

      let value: unknown;
      await act(async () => {
        value = await result.current.withRetry(fn, { maxRetries: 3, delayMs: 0 });
      });

      expect(value).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('withRetry should throw after max retries exhausted with exact call count', async () => {
      const fn = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });

      const { result } = renderHook(() => useArca());

      // maxRetries: 2 means 1 initial + 2 retries = 3 total calls
      let caughtError: Error | undefined;
      await act(async () => {
        try {
          await result.current.withRetry(fn, { maxRetries: 2, delayMs: 0 });
        } catch (e) {
          caughtError = e as Error;
        }
      });

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toBe('Failed to fetch');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('withRetry should NOT retry non-retriable errors', async () => {
      const fn = vi.fn(async () => {
        throw new Error('Not a network error');
      });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => {
          await result.current.withRetry(fn, { maxRetries: 3, delayMs: 0 });
        }),
      ).rejects.toThrow('Not a network error');

      // Should not retry — only called once
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('withRetry should succeed on first try without retrying', async () => {
      const fn = vi.fn(async () => 'immediate-success');

      const { result } = renderHook(() => useArca());

      let value: unknown;
      await act(async () => {
        value = await result.current.withRetry(fn, { maxRetries: 3, delayMs: 0 });
      });

      expect(value).toBe('immediate-success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('withRetry should use default options when none provided', async () => {
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount < 2) {
          throw new TypeError('Failed to fetch');
        }
        return 'ok';
      });

      // Mock setTimeout to avoid actual delays (default delayMs is 1000)
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') handler();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const { result } = renderHook(() => useArca());

      let value: unknown;
      await act(async () => {
        value = await result.current.withRetry(fn);
      });

      expect(value).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
    });

    it('withRetry should use exponential backoff (delay doubles each attempt)', async () => {
      const delays: number[] = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler, ms?: number) => {
        delays.push(ms ?? 0);
        if (typeof fn === 'function') fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const fn = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });

      const { result } = renderHook(() => useArca());

      try {
        await act(async () => {
          await result.current.withRetry(fn, { maxRetries: 3, delayMs: 100 });
        });
      } catch {
        // expected
      }

      // Expect 3 delays: 100, 200, 400 (exponential backoff: delayMs * 2^attempt)
      expect(delays).toHaveLength(3);
      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
      expect(delays[2]).toBe(400);

      vi.restoreAllMocks();
    });

    it('withRetry should throw the last error, not an intermediate one', async () => {
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        throw new TypeError(`Fail attempt ${callCount}`);
      });

      const { result } = renderHook(() => useArca());

      let caughtError: Error | undefined;
      await act(async () => {
        try {
          await result.current.withRetry(fn, { maxRetries: 1, delayMs: 0 });
        } catch (e) {
          caughtError = e as Error;
        }
      });

      // maxRetries: 1 = 1 initial + 1 retry = 2 calls
      expect(fn).toHaveBeenCalledTimes(2);
      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toBe('Fail attempt 2');
    });

    it('withRetry should not retry with maxRetries: 0', async () => {
      const fn = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });

      const { result } = renderHook(() => useArca());

      let caughtError: Error | undefined;
      await act(async () => {
        try {
          await result.current.withRetry(fn, { maxRetries: 0, delayMs: 0 });
        } catch (e) {
          caughtError = e as Error;
        }
      });

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toBe('Failed to fetch');
      // maxRetries: 0 means 1 initial try, no retries
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('withRetry should forward onRetry callback to the shared utility', async () => {
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount < 3) throw new TypeError('Failed to fetch');
        return 'recovered';
      });

      const onRetry = vi.fn();
      const { result } = renderHook(() => useArca());

      let value: unknown;
      await act(async () => {
        value = await result.current.withRetry(fn, {
          maxRetries: 3,
          delayMs: 0,
          onRetry,
        });
      });

      expect(value).toBe('recovered');
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(TypeError));
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(TypeError));
    });

    it('withRetry should not call onRetry on first success', async () => {
      const fn = vi.fn(async () => 'ok');
      const onRetry = vi.fn();
      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.withRetry(fn, { onRetry });
      });

      expect(onRetry).not.toHaveBeenCalled();
    });
  });
});
