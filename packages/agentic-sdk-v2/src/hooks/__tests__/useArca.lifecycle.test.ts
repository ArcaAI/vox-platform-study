/**
 * @arcaai/vox - useArca Lifecycle Tests (C-001 Bug Fix)
 *
 * TDD tests for lifecycle property on useArca return interface.
 * The cross-tab-session page crashes because useArca() does not return `lifecycle`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';

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
  transcriptionPipelineState: null as Record<string, unknown> | null,
  knowledgePipelineState: null as Record<string, unknown> | null,
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
// C-001: Lifecycle interface on useArca
// =============================================================================

describe('C-001: useArca lifecycle interface', () => {
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

  // ---------------------------------------------------------------------------
  // 1. lifecycle exists on the return interface
  // ---------------------------------------------------------------------------

  it('useArca() should expose lifecycle on the return interface', () => {
    const { result } = renderHook(() => useArca());
    expect(result.current).toHaveProperty('lifecycle');
    expect(result.current.lifecycle).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 2-3. lifecycle.status
  // ---------------------------------------------------------------------------

  it('lifecycle.status should be IDLE when SDK is not ready', () => {
    currentMockStore = { ...currentMockStore, initialized: false, globalError: null };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.status).toBe('IDLE');
  });

  it('lifecycle.status should be RUNNING when SDK is initialized', () => {
    currentMockStore = { ...currentMockStore, initialized: true, globalError: null };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.status).toBe('RUNNING');
  });

  // ---------------------------------------------------------------------------
  // 4-6. lifecycle.canClose
  // ---------------------------------------------------------------------------

  it('lifecycle.canClose should be true when no audio is capturing and no summary is generating', () => {
    currentMockStore = {
      ...currentMockStore,
      isCapturing: false,
      summaryGenerating: false,
    };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.canClose).toBe(true);
  });

  it('lifecycle.canClose should be false when audio is capturing', () => {
    currentMockStore = {
      ...currentMockStore,
      isCapturing: true,
      summaryGenerating: false,
    };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.canClose).toBe(false);
  });

  it('lifecycle.canClose should be false when summary is generating', () => {
    currentMockStore = {
      ...currentMockStore,
      isCapturing: false,
      summaryGenerating: true,
    };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.canClose).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 7-9. lifecycle.pendingOperations
  // ---------------------------------------------------------------------------

  it('lifecycle.pendingOperations should list "audio_capture" when capturing', () => {
    currentMockStore = {
      ...currentMockStore,
      isCapturing: true,
      summaryGenerating: false,
    };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.pendingOperations).toContain('audio_capture');
  });

  it('lifecycle.pendingOperations should list "summary_generation" when generating', () => {
    currentMockStore = {
      ...currentMockStore,
      isCapturing: false,
      summaryGenerating: true,
    };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.pendingOperations).toContain('summary_generation');
  });

  it('lifecycle.pendingOperations should be empty when nothing is pending', () => {
    currentMockStore = {
      ...currentMockStore,
      isCapturing: false,
      summaryGenerating: false,
    };
    const { result } = renderHook(() => useArca());
    expect(result.current.lifecycle.pendingOperations).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 10-11. lifecycle.requestGracefulShutdown / forceShutdown
  // ---------------------------------------------------------------------------

  it('lifecycle.requestGracefulShutdown should stop audio and wait', async () => {
    const mockDestroy = vi.fn().mockResolvedValue(undefined);
    currentMockStore = {
      ...currentMockStore,
      isCapturing: true,
      pluginManager: { destroy: mockDestroy, getStates: vi.fn() },
    };

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.lifecycle.requestGracefulShutdown({ timeoutMs: 1000 });
    });

    expect(mockDestroy).toHaveBeenCalled();
    expect(currentMockStore.setIsCapturing).toHaveBeenCalledWith(false);
  });

  it('lifecycle.forceShutdown should stop audio immediately', async () => {
    const mockDestroy = vi.fn().mockResolvedValue(undefined);
    currentMockStore = {
      ...currentMockStore,
      isCapturing: true,
      pluginManager: { destroy: mockDestroy, getStates: vi.fn() },
    };

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.lifecycle.forceShutdown();
    });

    expect(mockDestroy).toHaveBeenCalled();
    expect(currentMockStore.setIsCapturing).toHaveBeenCalledWith(false);
  });

  // ---------------------------------------------------------------------------
  // 12. lifecycle.state sub-object
  // ---------------------------------------------------------------------------

  it('lifecycle.state should include audioCapture, transcriptionPipeline, knowledgePipeline, hasUnsavedData', () => {
    currentMockStore = {
      ...currentMockStore,
      isCapturing: true,
      summaryGenerating: false,
    };

    const { result } = renderHook(() => useArca());

    const { state } = result.current.lifecycle;
    expect(state).toHaveProperty('audioCapture');
    expect(state).toHaveProperty('transcriptionPipeline');
    expect(state).toHaveProperty('knowledgePipeline');
    expect(state).toHaveProperty('hasUnsavedData');
    expect(typeof state.audioCapture).toBe('string');
    expect(typeof state.transcriptionPipeline).toBe('string');
    expect(typeof state.knowledgePipeline).toBe('string');
    expect(typeof state.hasUnsavedData).toBe('boolean');
  });
});
