/**
 * @arcaai/vox - useArca Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { useArca } from '../useArca';
import { useAgenticStore } from '../../store';

// Mock the store
vi.mock('../../store', () => {
  const mockStore = {
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
      noiseFilter: { isActive: false, isInitialized: false },
      vad: { isActive: false, isInitialized: false },
      stt: { isActive: false, isInitialized: false, provider: 'auto' },
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
    apiClient: null,
    pluginManager: null,
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
    setDNAStyle: vi.fn(),
    reset: vi.fn(),
  };

  return {
    useAgenticStore: vi.fn(() => mockStore),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
  };
});

describe('useArca', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hook structure', () => {
    it('should return session interface', () => {
      const { result } = renderHook(() => useArca());

      expect(result.current.session).toBeDefined();
      expect(result.current.session.consultation).toBeNull();
      expect(result.current.session.relatedConsultations).toEqual([]);
      expect(result.current.session.isLoading).toBe(false);
      expect(result.current.session.error).toBeNull();
      expect(typeof result.current.session.open).toBe('function');
      expect(typeof result.current.session.load).toBe('function');
      expect(typeof result.current.session.findByPatientDate).toBe('function');
      expect(typeof result.current.session.getPatientHistory).toBe('function');
      expect(typeof result.current.session.getTimeline).toBe('function');
    });

    it('should return audio interface', () => {
      const { result } = renderHook(() => useArca());

      expect(result.current.audio).toBeDefined();
      expect(result.current.audio.isCapturing).toBe(false);
      expect(result.current.audio.isMuted).toBe(false);
      expect(result.current.audio.level).toBe(0);
      expect(result.current.audio.isSpeaking).toBe(false);
      expect(result.current.audio.currentTranscript).toBe('');
      expect(typeof result.current.audio.start).toBe('function');
      expect(typeof result.current.audio.stop).toBe('function');
      expect(typeof result.current.audio.mute).toBe('function');
      expect(typeof result.current.audio.unmute).toBe('function');
      expect(typeof result.current.audio.toggleNoiseFilter).toBe('function');
    });

    it('should return context interface', () => {
      const { result } = renderHook(() => useArca());

      expect(result.current.context).toBeDefined();
      expect(result.current.context.items).toEqual([]);
      expect(result.current.context.transcriptions).toEqual([]);
      expect(result.current.context.caseNotes).toEqual([]);
      expect(result.current.context.entities).toEqual([]);
      expect(result.current.context.sharedContext).toEqual([]);
      expect(result.current.context.isLoading).toBe(false);
      expect(result.current.context.error).toBeNull();
      expect(typeof result.current.context.addCaseNote).toBe('function');
      expect(typeof result.current.context.addTranscription).toBe('function');
      expect(typeof result.current.context.updateItem).toBe('function');
      expect(typeof result.current.context.loadSharedContext).toBe('function');
      expect(typeof result.current.context.extractEntities).toBe('function');
    });

    it('should return summary interface', () => {
      const { result } = renderHook(() => useArca());

      expect(result.current.summary).toBeDefined();
      expect(result.current.summary.preSummary).toBeNull();
      expect(result.current.summary.summary).toBeNull();
      expect(result.current.summary.all).toEqual([]);
      expect(result.current.summary.dnaStyle).toBeNull();
      expect(result.current.summary.isGenerating).toBe(false);
      expect(result.current.summary.error).toBeNull();
      expect(typeof result.current.summary.generatePreSummary).toBe('function');
      expect(typeof result.current.summary.generateSummary).toBe('function');
      expect(typeof result.current.summary.updateSummary).toBe('function');
      expect(typeof result.current.summary.analyzeDNA).toBe('function');
    });

    it('should return pipeline control interface', () => {
      const { result } = renderHook(() => useArca());

      expect(result.current.pipelines).toBeDefined();
      expect(result.current.pipelines.transcription).toBeNull();
      expect(result.current.pipelines.knowledge).toBeNull();
      expect(typeof result.current.pipelines.pauseTranscription).toBe('function');
      expect(typeof result.current.pipelines.resumeTranscription).toBe('function');
      expect(typeof result.current.pipelines.triggerNER).toBe('function');
      expect(typeof result.current.pipelines.triggerSummarization).toBe('function');
    });

    it('should return isReady and error', () => {
      const { result } = renderHook(() => useArca());

      expect(result.current.isReady).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('should return isAudioSource', () => {
      const { result } = renderHook(() => useArca());

      expect(typeof result.current.isAudioSource).toBe('boolean');
    });
  });

  describe('session actions', () => {
    it('should throw when opening consultation without API client', async () => {
      const { result } = renderHook(() => useArca());

      await expect(
        result.current.session.open({
          patientId: 'patient-1',
          appointmentDate: '2026-01-27',
        })
      ).rejects.toThrow('SDK not initialized');
    });

    it('should throw when loading consultation without API client', async () => {
      const { result } = renderHook(() => useArca());

      await expect(result.current.session.load('cons-123')).rejects.toThrow(
        'SDK not initialized'
      );
    });
  });

  describe('audio actions', () => {
    it('should throw when starting audio without plugin manager', async () => {
      const { result } = renderHook(() => useArca());

      await expect(result.current.audio.start()).rejects.toThrow('SDK not initialized');
    });

    it('should not throw when stopping audio without plugin manager', async () => {
      const { result } = renderHook(() => useArca());

      // Should not throw
      await result.current.audio.stop();
    });

    it('should call store methods for mute/unmute', () => {
      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.audio.mute();
      });

      act(() => {
        result.current.audio.unmute();
      });
    });
  });

  describe('context actions', () => {
    it('should throw when adding case note without API client', async () => {
      const { result } = renderHook(() => useArca());

      await expect(result.current.context.addCaseNote('Test note')).rejects.toThrow(
        'SDK not initialized'
      );
    });

    it('should throw when adding transcription without API client', async () => {
      const { result } = renderHook(() => useArca());

      await expect(
        result.current.context.addTranscription('Test transcription')
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('summary actions', () => {
    it('should throw when generating summary without API client', async () => {
      const { result } = renderHook(() => useArca());

      await expect(result.current.summary.generateSummary()).rejects.toThrow(
        'SDK not initialized'
      );
    });

    it('should throw unsupported error when analyzing DNA (SUM-06: no backend)', async () => {
      const { result } = renderHook(() => useArca());

      await expect(result.current.summary.analyzeDNA(['text1', 'text2'])).rejects.toThrow(
        'DNA analysis is not supported'
      );
    });
  });

  describe('pipeline actions', () => {
    it('should not throw when pausing transcription without pipeline', () => {
      const { result } = renderHook(() => useArca());

      // Should not throw
      act(() => {
        result.current.pipelines.pauseTranscription();
      });
    });

    it('should not throw when resuming transcription without pipeline', () => {
      const { result } = renderHook(() => useArca());

      // Should not throw
      act(() => {
        result.current.pipelines.resumeTranscription();
      });
    });

    it('should throw when triggering NER without knowledge pipeline', async () => {
      const { result } = renderHook(() => useArca());

      await expect(result.current.pipelines.triggerNER()).rejects.toThrow(
        'Knowledge pipeline not initialized'
      );
    });

    it('should throw when triggering summarization without consultation', async () => {
      const { result } = renderHook(() => useArca());

      await expect(result.current.pipelines.triggerSummarization()).rejects.toThrow(
        'No active consultation'
      );
    });
  });

  // ===========================================================================
  // Stream B Gap Fixes (SDK-206, Layer 1)
  // ===========================================================================

  describe('NER-L-02: auto-NER on transcription callback', () => {
    function setupAutoNERMocks(overrides?: {
      knowledgePipelineState?: { isReady: boolean };
      knowledgePipeline?: { process: ReturnType<typeof vi.fn>; state: { isReady: boolean } } | null;
      processResult?: unknown;
      processError?: Error;
    }) {
      const defaultProcessResult = {
        entities: [{ id: 'e1', entityType: 'DISEASE', text: 'diabetes' }],
      };

      const mockKnowledgePipeline = overrides?.knowledgePipeline ?? {
        process: overrides?.processError
          ? vi.fn().mockRejectedValue(overrides.processError)
          : vi.fn().mockResolvedValue(overrides?.processResult ?? defaultProcessResult),
        state: overrides?.knowledgePipelineState ?? { isReady: true },
      };

      const mockSetCallbacks = vi.fn();
      const mockPluginManager = {
        setCallbacks: mockSetCallbacks,
        initialize: vi.fn().mockResolvedValue(undefined),
        getStates: vi.fn().mockReturnValue({
          noiseFilter: { isActive: false },
          vad: { isActive: false },
          stt: { isActive: false },
        }),
        getKnowledgePipeline: vi.fn().mockReturnValue(
          overrides?.knowledgePipeline === null ? null : mockKnowledgePipeline
        ),
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      const store = (useAgenticStore as unknown as Function)();
      store.pluginManager = mockPluginManager;
      store.apiClient = {
        post: vi.fn().mockResolvedValue({
          id: 'ctx-1',
          type: 'transcription',
          content: 'Patient has diabetes',
        }),
      };
      store.consultation = {
        id: 'cons-123',
        patientId: 'p1',
        doctorId: 'd1',
        appointmentDate: '2026-02-17',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Mock navigator.mediaDevices
      const mockTrack = {
        label: 'Microphone',
        getSettings: () => ({ sampleRate: 44100 }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const mockStream = {
        getAudioTracks: () => [mockTrack],
      };
      Object.defineProperty(global.navigator, 'mediaDevices', {
        value: {
          getUserMedia: vi.fn().mockResolvedValue(mockStream),
        },
        writable: true,
        configurable: true,
      });

      // Mock AudioContext as a proper constructor
      (global as unknown as Record<string, unknown>).AudioContext = class MockAudioContext {
        sampleRate = 44100;
        close = vi.fn();
      };

      return { mockKnowledgePipeline, mockSetCallbacks, store };
    }

    async function startAudioAndGetCallbacks(
      hookResult: { current: ReturnType<typeof useArca> },
      mockSetCallbacks: ReturnType<typeof vi.fn>
    ) {
      await act(async () => {
        await hookResult.current.audio.start();
      });

      expect(mockSetCallbacks).toHaveBeenCalledWith(
        expect.objectContaining({
          onTranscription: expect.any(Function),
        })
      );

      return mockSetCallbacks.mock.calls[0][0];
    }

    it('should trigger knowledge pipeline on final transcriptions', async () => {
      const { mockKnowledgePipeline, mockSetCallbacks, store } = setupAutoNERMocks();
      const { result } = renderHook(() => useArca());

      const callbacks = await startAudioAndGetCallbacks(result, mockSetCallbacks);

      await act(async () => {
        await callbacks.onTranscription({
          text: 'Patient has diabetes',
          isFinal: true,
          segments: [],
        });
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(mockKnowledgePipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Patient has diabetes' })
      );
      expect(store.addEntities).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ entityType: 'DISEASE', text: 'diabetes' }),
        ])
      );
    });

    it('should NOT trigger NER on non-final (partial) transcriptions', async () => {
      const { mockKnowledgePipeline, mockSetCallbacks } = setupAutoNERMocks();
      const { result } = renderHook(() => useArca());

      const callbacks = await startAudioAndGetCallbacks(result, mockSetCallbacks);

      await act(async () => {
        await callbacks.onTranscription({
          text: 'Patient has...',
          isFinal: false,
          segments: [],
        });
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(mockKnowledgePipeline.process).not.toHaveBeenCalled();
    });

    it('should skip auto-NER when knowledge pipeline is not ready', async () => {
      const { mockKnowledgePipeline, mockSetCallbacks } = setupAutoNERMocks({
        knowledgePipelineState: { isReady: false },
      });
      const { result } = renderHook(() => useArca());

      const callbacks = await startAudioAndGetCallbacks(result, mockSetCallbacks);

      await act(async () => {
        await callbacks.onTranscription({
          text: 'Patient has diabetes',
          isFinal: true,
          segments: [],
        });
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(mockKnowledgePipeline.process).not.toHaveBeenCalled();
    });

    it('should skip auto-NER when no knowledge pipeline exists', async () => {
      const { mockSetCallbacks } = setupAutoNERMocks({
        knowledgePipeline: null,
      });
      const { result } = renderHook(() => useArca());

      const callbacks = await startAudioAndGetCallbacks(result, mockSetCallbacks);

      // Should not throw — the null pipeline path is silently skipped
      await act(async () => {
        await callbacks.onTranscription({
          text: 'Patient has diabetes',
          isFinal: true,
          segments: [],
        });
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      // No assertion on process — the pipeline is null, so nothing to call
    });

    it('should not crash transcription flow when auto-NER fails', async () => {
      const { mockSetCallbacks, store } = setupAutoNERMocks({
        processError: new Error('NER model failed'),
      });
      const { result } = renderHook(() => useArca());

      const callbacks = await startAudioAndGetCallbacks(result, mockSetCallbacks);

      // Should not throw even though pipeline.process rejects
      await act(async () => {
        await callbacks.onTranscription({
          text: 'Patient has diabetes',
          isFinal: true,
          segments: [],
        });
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      // Transcription context posting should still succeed
      expect(store.apiClient.post).toHaveBeenCalled();
      // addEntities should NOT be called since process failed
      expect(store.addEntities).not.toHaveBeenCalled();
    });

    it('should not call addEntities when pipeline returns zero entities', async () => {
      const { mockSetCallbacks, store } = setupAutoNERMocks({
        processResult: { entities: [] },
      });
      const { result } = renderHook(() => useArca());

      const callbacks = await startAudioAndGetCallbacks(result, mockSetCallbacks);

      await act(async () => {
        await callbacks.onTranscription({
          text: 'Hello world no entities',
          isFinal: true,
          segments: [],
        });
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(store.addEntities).not.toHaveBeenCalled();
    });
  });

  describe('SUM-06: DNA methods throw unsupported error', () => {
    it('should throw UnsupportedError when analyzeDNA is called', async () => {
      const store = (useAgenticStore as unknown as Function)();
      store.apiClient = {
        post: vi.fn(),
      };

      const { result } = renderHook(() => useArca());

      await expect(result.current.summary.analyzeDNA(['text1', 'text2'])).rejects.toThrow(
        'DNA analysis is not supported'
      );

      // Should NOT call the API at all
      expect(store.apiClient.post).not.toHaveBeenCalled();
    });

    it('should still have analyzeDNA as a function in the interface', () => {
      const { result } = renderHook(() => useArca());
      expect(typeof result.current.summary.analyzeDNA).toBe('function');
    });

    it('should throw unsupported error even with empty texts array', async () => {
      const store = (useAgenticStore as unknown as Function)();
      store.apiClient = { post: vi.fn() };

      const { result } = renderHook(() => useArca());

      await expect(result.current.summary.analyzeDNA([])).rejects.toThrow(
        'DNA analysis is not supported'
      );
      expect(store.apiClient.post).not.toHaveBeenCalled();
    });

    it('should include guidance in the error message about future support', async () => {
      const { result } = renderHook(() => useArca());

      try {
        await result.current.summary.analyzeDNA(['text']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('no backend endpoint exists');
        expect((error as Error).message).toContain('future release');
      }
    });

    it('should throw unsupported error regardless of initialization state', async () => {
      // Even without apiClient or pluginManager, DNA should throw unsupported (not "SDK not initialized")
      const store = (useAgenticStore as unknown as Function)();
      store.apiClient = null;
      store.pluginManager = null;

      const { result } = renderHook(() => useArca());

      await expect(result.current.summary.analyzeDNA(['text'])).rejects.toThrow(
        'DNA analysis is not supported'
      );
    });
  });
});
