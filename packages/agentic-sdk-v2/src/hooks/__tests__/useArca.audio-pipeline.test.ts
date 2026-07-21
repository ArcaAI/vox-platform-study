/**
 * useArca Hook — Audio, Pipeline, Error-Path & Selector Tests
 *
 * Covers the remaining uncovered code paths in useArca.ts:
 * - Audio actions (startAudio, stopAudio, muteAudio, unmuteAudio, toggleNoiseFilter)
 * - Pipeline actions (pauseTranscription, resumeTranscription, triggerNER, triggerSummarization)
 * - Error paths for context/summary/session operations
 * - latestSummary / latestPreSummary selectors
 * - loadConsultation with contextItems
 * - findByPatientDate
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArca } from '../useArca';
import { useAgenticStore } from '../../store';
import { AgenticClient } from '../../core/AgenticClient';
import {
  createMockLogger,
  mockFetch,
  createMockResponse,
  createMockConsultation,
  createMockContextItem,
  createMockSummary,
} from '../../__tests__/setup';

vi.mock('../../store', () => {
  const mockStore: Record<string, unknown> = {};
  return {
    useAgenticStore: vi.fn(() => mockStore),
    selectTranscriptions: vi.fn(() => []),
    selectCaseNotes: vi.fn(() => []),
    selectIsAudioSource: vi.fn(() => false),
    selectTranscriptionPipelineState: vi.fn(() => null),
    selectKnowledgePipelineState: vi.fn(() => null),
  };
});

vi.mock('../../utils/diffUtils', () => ({
  computeSummaryDiff: vi.fn((a: string, b: string) => ({
    changes: [{ value: a }, { value: b, added: true }],
    patch: '',
    stats: { additions: 1, deletions: 0, unchanged: 1 },
  })),
}));

let mockStoreData: Record<string, any>;
let mockLogger: ReturnType<typeof createMockLogger>;
let apiClient: AgenticClient;

function createMockPluginManager(overrides: Record<string, any> = {}) {
  return {
    setCallbacks: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    getStates: vi.fn(() => ({
      noiseFilter: { isActive: false, isInitialized: true },
      vad: { isActive: true, isInitialized: true },
      stt: { isActive: true, isInitialized: true, provider: 'auto' },
    })),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    getTranscriptionPipeline: vi.fn<() => { state: { isReady: boolean }; process: ReturnType<typeof vi.fn> } | null>(() => null),
    getKnowledgePipeline: vi.fn<() => { state: { isReady: boolean }; process: ReturnType<typeof vi.fn> } | null>(() => null),
    ...overrides,
  };
}

function setupStore(overrides: Record<string, any> = {}) {
  mockLogger = createMockLogger();
  apiClient = new AgenticClient(
    { baseUrl: 'http://test', apiKey: 'test-key' },
    mockLogger,
  );

  mockStoreData = {
    apiClient,
    consultation: createMockConsultation({ id: 'cons-1', patientId: 'p1' }),
    relatedConsultations: [],
    contextItems: [],
    entities: [],
    sharedContext: [],
    summaries: [],
    dnaStyle: null,
    preferences: {},

    sessionLoading: false,
    sessionError: null,
    contextLoading: false,
    contextError: null,
    summaryGenerating: false,
    summaryError: null,
    audioError: null,

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

    initialized: true,
    globalError: null,
    logger: mockLogger,
    pluginManager: null,

    transcriptionPipelineState: null,
    knowledgePipelineState: null,
    isAudioSource: false,
    audioSourceTabId: null,

    setSessionLoading: vi.fn(),
    setSessionError: vi.fn(),
    setConsultation: vi.fn(),
    setRelatedConsultations: vi.fn(),
    clearContext: vi.fn(),
    addContextItem: vi.fn(),
    updateContextItem: vi.fn(),
    setContextLoading: vi.fn(),
    setContextError: vi.fn(),
    setSharedContext: vi.fn(),
    setEntities: vi.fn(),
    addEntities: vi.fn(),
    setSummaryGenerating: vi.fn(),
    setSummaryError: vi.fn(),
    addSummary: vi.fn(),
    setSummaries: vi.fn(),
    setDNAStyle: vi.fn(),
    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    // useArca.audio now delegates to useArcaAudio,
    // which reads/writes activeStream / activeAudioContext / transcript segments
    // / audio language. The mock must expose both the state fields and the
    // matching setters or the delegated start/stop path throws.
    activeStream: null,
    activeAudioContext: null,
    transcriptSegments: [],
    audioLanguage: 'en',
    setActiveStream: vi.fn(),
    setActiveAudioContext: vi.fn(),
    addTranscriptSegment: vi.fn(),
    setAudioLanguage: vi.fn(),
    // Audio-drop actions the hook calls on start/stop and per drop.
    resetAudioDropped: vi.fn(),
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };

  (useAgenticStore as any).mockReturnValue(mockStoreData);
}

beforeEach(() => {
  setupStore();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ===========================================================================
// SESSION — loadConsultation with contextItems + error path
// ===========================================================================

describe('useArca — session load with contextItems', () => {
  it('should iterate consultation.contextItems when present', async () => {
    const items = [
      createMockContextItem({ id: 'ci-1' }),
      createMockContextItem({ id: 'ci-2' }),
    ];
    const consultation = createMockConsultation({ id: 'loaded-ctx', contextItems: items });
    mockFetch.mockResolvedValueOnce(createMockResponse(consultation));

    const { result } = renderHook(() => useArca());

    await act(async () => {
      await result.current.session.load('loaded-ctx');
    });

    expect(mockStoreData.addContextItem).toHaveBeenCalledTimes(2);
    expect(mockStoreData.addContextItem).toHaveBeenCalledWith(items[0]);
    expect(mockStoreData.addContextItem).toHaveBeenCalledWith(items[1]);
  });

  it('should set session error on loadConsultation failure', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.session.load('bad-id'); }),
    ).rejects.toThrow();

    expect(mockStoreData.setSessionError).toHaveBeenCalled();
  });
});

describe('useArca — session findByPatientDate', () => {
  it('should throw when SDK not initialized', async () => {
    setupStore({ apiClient: null });

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.session.findByPatientDate('p1', '2026-02-19'); }),
    ).rejects.toThrow('SDK not initialized');
  });
});

describe('useArca — session getPatientHistory', () => {
  it('should throw when SDK not initialized', async () => {
    setupStore({ apiClient: null });

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.session.getPatientHistory('p1'); }),
    ).rejects.toThrow('SDK not initialized');
  });
});

describe('useArca — session getTimeline error path', () => {
  it('should rethrow API error from getTimeline', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.session.getTimeline(); }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// AUDIO ACTIONS
// ===========================================================================

describe('useArca — audio actions', () => {
  describe('startAudio()', () => {
    it('should request media, initialize plugins and set store flags', async () => {
      const mockTrack = { label: 'mic-1' };
      const mockStream = { getAudioTracks: () => [mockTrack] };

      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(mockStream),
        },
      });
      vi.stubGlobal('AudioContext', class { sampleRate = 48000; });

      const pluginManager = createMockPluginManager();
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.start();
      });

      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(pluginManager.setCallbacks).toHaveBeenCalled();
      expect(pluginManager.initialize).toHaveBeenCalledWith(mockTrack, expect.objectContaining({ sampleRate: 48000 }));
      expect(mockStoreData.setIsCapturing).toHaveBeenCalledWith(true);
      expect(mockStoreData.setAudioPlugins).toHaveBeenCalled();
      expect(mockStoreData.setAudioError).toHaveBeenCalledWith(null);
    });

    it('should set audio error and rethrow on failure', async () => {
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue(new Error('Mic denied')),
        },
      });

      const pluginManager = createMockPluginManager();
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.audio.start(); }),
      ).rejects.toThrow('Mic denied');

      expect(mockStoreData.setAudioError).toHaveBeenCalled();
    });

    it('should throw when pluginManager is null', async () => {
      setupStore({ pluginManager: null });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.audio.start(); }),
      ).rejects.toThrow('SDK not initialized');
    });

    describe('onTranscription callback', () => {
      let pluginManager: ReturnType<typeof createMockPluginManager>;
      let onTranscriptionCb: (result: any) => void;

      beforeEach(async () => {
        const mockTrack = { label: 'mic-2' };
        const mockStream = { getAudioTracks: () => [mockTrack] };
        vi.stubGlobal('navigator', {
          mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
        });
        vi.stubGlobal('AudioContext', class { sampleRate = 44100; });

        pluginManager = createMockPluginManager();
        setupStore({ pluginManager });

        const { result } = renderHook(() => useArca());
        await act(async () => { await result.current.audio.start(); });

        const cbArgs = pluginManager.setCallbacks.mock.calls[0][0];
        onTranscriptionCb = cbArgs.onTranscription;
      });

      it('should set currentTranscript for interim results', () => {
        onTranscriptionCb({ text: 'partial text', isFinal: false, segments: [] });
        expect(mockStoreData.setCurrentTranscript).toHaveBeenCalledWith('partial text');
      });

      it('should clear transcript and POST context on final result', async () => {
        const item = createMockContextItem({ id: 'auto-ctx' });
        mockFetch.mockResolvedValueOnce(createMockResponse(item));

        onTranscriptionCb({ text: 'Final statement', isFinal: true, segments: [{ text: 'Final statement' }] });

        await vi.waitFor(() => {
          expect(mockStoreData.setCurrentTranscript).toHaveBeenCalledWith('');
        });

        await vi.waitFor(() => {
          expect(mockStoreData.addContextItem).toHaveBeenCalledWith(item);
        });
      });

      // Word timings emitted on the wire must reach
      // the store via the final-segment bridge so consumers can read words
      // from `audio.transcriptSegments`.
      it('should carry word-level timestamps into the stored transcript segment', () => {
        mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));

        const words = [
          { word: 'patient', start: 0.0, end: 0.4, confidence: 0.97 },
          { word: 'coughing', start: 0.4, end: 1.0, confidence: 0.88 },
        ];
        onTranscriptionCb({ text: 'patient coughing', isFinal: true, segments: [], words });

        expect(mockStoreData.addTranscriptSegment).toHaveBeenCalledTimes(1);
        const segment = mockStoreData.addTranscriptSegment.mock.calls[0][0];
        expect(segment.text).toBe('patient coughing');
        expect(segment.isFinal).toBe(true);
        expect(segment.words).toEqual(words);
      });

      it('should store a final segment with undefined words when none are provided (back-compat)', () => {
        mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));

        onTranscriptionCb({ text: 'no word data', isFinal: true, segments: [] });

        expect(mockStoreData.addTranscriptSegment).toHaveBeenCalledTimes(1);
        const segment = mockStoreData.addTranscriptSegment.mock.calls[0][0];
        expect(segment.words).toBeUndefined();
      });

      it('should auto-trigger NER on final transcription when knowledge pipeline is ready', async () => {
        const mockEntities = [{ id: 'e1', entityType: 'DISEASE', text: 'flu' }];
        const mockPipeline = {
          state: { isReady: true },
          process: vi.fn().mockResolvedValue({ entities: mockEntities }),
        };
        pluginManager.getKnowledgePipeline.mockReturnValue(mockPipeline);

        mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));

        onTranscriptionCb({ text: 'Patient has flu', isFinal: true, segments: [] });

        await vi.waitFor(() => {
          expect(mockPipeline.process).toHaveBeenCalledWith({ text: 'Patient has flu' });
        });

        await vi.waitFor(() => {
          expect(mockStoreData.addEntities).toHaveBeenCalledWith(mockEntities);
        });
      });

      it('should handle NER failure gracefully', async () => {
        const mockPipeline = {
          state: { isReady: true },
          process: vi.fn().mockRejectedValue(new Error('NER failed')),
        };
        pluginManager.getKnowledgePipeline.mockReturnValue(mockPipeline);

        mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));

        onTranscriptionCb({ text: 'test text', isFinal: true, segments: [] });

        await vi.waitFor(() => {
          expect(mockPipeline.process).toHaveBeenCalled();
        });
      });

      it('should handle context POST failure gracefully', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Context post failed'));

        onTranscriptionCb({ text: 'fail text', isFinal: true, segments: [] });

        await vi.waitFor(() => {
          expect(mockStoreData.setCurrentTranscript).toHaveBeenCalledWith('');
        });
      });

      it('should skip NER when knowledge pipeline is not ready', async () => {
        const mockPipeline = {
          state: { isReady: false },
          process: vi.fn(),
        };
        pluginManager.getKnowledgePipeline.mockReturnValue(mockPipeline);

        mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));

        onTranscriptionCb({ text: 'some text', isFinal: true, segments: [] });

        await vi.waitFor(() => {
          expect(mockStoreData.setCurrentTranscript).toHaveBeenCalledWith('');
        });

        expect(mockPipeline.process).not.toHaveBeenCalled();
      });

      it('should skip NER when knowledge pipeline is null', async () => {
        pluginManager.getKnowledgePipeline.mockReturnValue(null);

        mockFetch.mockResolvedValueOnce(createMockResponse(createMockContextItem()));

        onTranscriptionCb({ text: 'some text', isFinal: true, segments: [] });

        await vi.waitFor(() => {
          expect(mockStoreData.setCurrentTranscript).toHaveBeenCalledWith('');
        });
      });
    });

    describe('onVADEvent callback', () => {
      it('should set isSpeaking true on speech-start', async () => {
        const mockTrack = { label: 'mic' };
        vi.stubGlobal('navigator', {
          mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getAudioTracks: () => [mockTrack] }) },
        });
        vi.stubGlobal('AudioContext', class { sampleRate = 44100; });

        const pluginManager = createMockPluginManager();
        setupStore({ pluginManager });

        const { result } = renderHook(() => useArca());
        await act(async () => { await result.current.audio.start(); });

        const cbArgs = pluginManager.setCallbacks.mock.calls[0][0];
        cbArgs.onVADEvent({ type: 'speech-start' });

        expect(mockStoreData.setIsSpeaking).toHaveBeenCalledWith(true);
      });

      it('should set isSpeaking false on speech-end', async () => {
        const mockTrack = { label: 'mic' };
        vi.stubGlobal('navigator', {
          mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getAudioTracks: () => [mockTrack] }) },
        });
        vi.stubGlobal('AudioContext', class { sampleRate = 44100; });

        const pluginManager = createMockPluginManager();
        setupStore({ pluginManager });

        const { result } = renderHook(() => useArca());
        await act(async () => { await result.current.audio.start(); });

        const cbArgs = pluginManager.setCallbacks.mock.calls[0][0];
        cbArgs.onVADEvent({ type: 'speech-end' });

        expect(mockStoreData.setIsSpeaking).toHaveBeenCalledWith(false);
      });
    });

    describe('onError callback', () => {
      it('should set audio error from plugin error', async () => {
        const mockTrack = { label: 'mic' };
        vi.stubGlobal('navigator', {
          mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getAudioTracks: () => [mockTrack] }) },
        });
        vi.stubGlobal('AudioContext', class { sampleRate = 44100; });

        const pluginManager = createMockPluginManager();
        setupStore({ pluginManager });

        const { result } = renderHook(() => useArca());
        await act(async () => { await result.current.audio.start(); });

        const cbArgs = pluginManager.setCallbacks.mock.calls[0][0];
        const pluginError = new Error('VAD crashed');
        cbArgs.onError(pluginError, 'vad');

        expect(mockStoreData.setAudioError).toHaveBeenCalledWith(pluginError);
      });
    });
  });

  describe('stopAudio()', () => {
    it('should destroy plugins and reset audio store flags', async () => {
      const pluginManager = createMockPluginManager();
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.stop();
      });

      expect(pluginManager.destroy).toHaveBeenCalled();
      expect(mockStoreData.setIsCapturing).toHaveBeenCalledWith(false);
      expect(mockStoreData.setIsSpeaking).toHaveBeenCalledWith(false);
      expect(mockStoreData.setAudioLevel).toHaveBeenCalledWith(0);
      expect(mockStoreData.setCurrentTranscript).toHaveBeenCalledWith('');
    });

    it('should return early when pluginManager is null', async () => {
      setupStore({ pluginManager: null });

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.stop();
      });

      expect(mockStoreData.setIsCapturing).not.toHaveBeenCalled();
    });
  });

  describe('muteAudio()', () => {
    it('should set isMuted to true', () => {
      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.audio.mute();
      });

      expect(mockStoreData.setIsMuted).toHaveBeenCalledWith(true);
    });
  });

  describe('unmuteAudio()', () => {
    it('should set isMuted to false', () => {
      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.audio.unmute();
      });

      expect(mockStoreData.setIsMuted).toHaveBeenCalledWith(false);
    });
  });

  describe('toggleNoiseFilter()', () => {
    it('should toggle noise filter to the opposite of current state', async () => {
      const pluginManager = createMockPluginManager();
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleNoiseFilter();
      });

      expect(pluginManager.setEnabled).toHaveBeenCalledWith('noiseFilter', true);
      expect(mockStoreData.setAudioPlugins).toHaveBeenCalled();
    });

    it('should use explicit enabled parameter when provided', async () => {
      const pluginManager = createMockPluginManager();
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleNoiseFilter(false);
      });

      expect(pluginManager.setEnabled).toHaveBeenCalledWith('noiseFilter', false);
    });

    it('should return early when pluginManager is null', async () => {
      setupStore({ pluginManager: null });

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.audio.toggleNoiseFilter();
      });

      expect(mockStoreData.setAudioPlugins).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// PIPELINE ACTIONS
// ===========================================================================

describe('useArca — pipeline actions', () => {
  describe('pauseTranscription()', () => {
    it('should call pipeline.pause() when pipeline exists', () => {
      const mockPipeline = { pause: vi.fn(), resume: vi.fn() };
      const pluginManager = createMockPluginManager({
        getTranscriptionPipeline: vi.fn(() => mockPipeline),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.pipelines.pauseTranscription();
      });

      expect(mockPipeline.pause).toHaveBeenCalled();
    });

    it('should do nothing when pluginManager is null', () => {
      setupStore({ pluginManager: null });

      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.pipelines.pauseTranscription();
      });
    });

    it('should do nothing when pipeline is null', () => {
      const pluginManager = createMockPluginManager({
        getTranscriptionPipeline: vi.fn(() => null),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.pipelines.pauseTranscription();
      });
    });
  });

  describe('resumeTranscription()', () => {
    it('should call pipeline.resume() when pipeline exists', () => {
      const mockPipeline = { pause: vi.fn(), resume: vi.fn() };
      const pluginManager = createMockPluginManager({
        getTranscriptionPipeline: vi.fn(() => mockPipeline),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.pipelines.resumeTranscription();
      });

      expect(mockPipeline.resume).toHaveBeenCalled();
    });

    it('should do nothing when pluginManager is null', () => {
      setupStore({ pluginManager: null });

      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.pipelines.resumeTranscription();
      });
    });

    it('should do nothing when pipeline is null', () => {
      const pluginManager = createMockPluginManager({
        getTranscriptionPipeline: vi.fn(() => null),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      act(() => {
        result.current.pipelines.resumeTranscription();
      });
    });
  });

  describe('triggerNER()', () => {
    it('should call knowledge pipeline triggerNER and store entities', async () => {
      const entities = [
        { id: 'ne-1', entityType: 'DISEASE', text: 'fever' },
        { id: 'ne-2', entityType: 'SYMPTOM', text: 'cough' },
      ];
      const mockPipeline = {
        triggerNER: vi.fn().mockResolvedValue(entities),
      };
      const pluginManager = createMockPluginManager({
        getKnowledgePipeline: vi.fn(() => mockPipeline),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.pipelines.triggerNER('Patient has fever');
      });

      expect(mockPipeline.triggerNER).toHaveBeenCalledWith('Patient has fever');
      expect(mockStoreData.addEntities).toHaveBeenCalledWith(entities);
      expect(returned).toEqual(entities);
    });

    it('should call triggerNER without text argument', async () => {
      const mockPipeline = {
        triggerNER: vi.fn().mockResolvedValue([]),
      };
      const pluginManager = createMockPluginManager({
        getKnowledgePipeline: vi.fn(() => mockPipeline),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await act(async () => {
        await result.current.pipelines.triggerNER();
      });

      expect(mockPipeline.triggerNER).toHaveBeenCalledWith(undefined);
    });

    it('should throw when knowledge pipeline is not initialized', async () => {
      const pluginManager = createMockPluginManager({
        getKnowledgePipeline: vi.fn(() => null),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.pipelines.triggerNER(); }),
      ).rejects.toThrow('Knowledge pipeline not initialized');
    });

    it('should rethrow NER errors', async () => {
      const mockPipeline = {
        triggerNER: vi.fn().mockRejectedValue(new Error('NER engine crashed')),
      };
      const pluginManager = createMockPluginManager({
        getKnowledgePipeline: vi.fn(() => mockPipeline),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.pipelines.triggerNER('test'); }),
      ).rejects.toThrow('NER engine crashed');
    });
  });

  describe('triggerSummarization()', () => {
    it('should call knowledge pipeline triggerSummarization and return result', async () => {
      const mockPipeline = {
        triggerSummarization: vi.fn().mockResolvedValue('Summary of consultation'),
      };
      const pluginManager = createMockPluginManager({
        getKnowledgePipeline: vi.fn(() => mockPipeline),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());
      let returned: any;

      await act(async () => {
        returned = await result.current.pipelines.triggerSummarization();
      });

      expect(mockPipeline.triggerSummarization).toHaveBeenCalledWith('cons-1');
      expect(returned).toBe('Summary of consultation');
    });

    it('should throw when no active consultation', async () => {
      const pluginManager = createMockPluginManager();
      setupStore({ pluginManager, consultation: null });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.pipelines.triggerSummarization(); }),
      ).rejects.toThrow('No active consultation');
    });

    it('should throw when knowledge pipeline is not initialized', async () => {
      const pluginManager = createMockPluginManager({
        getKnowledgePipeline: vi.fn(() => null),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.pipelines.triggerSummarization(); }),
      ).rejects.toThrow('Knowledge pipeline not initialized');
    });

    it('should rethrow summarization errors', async () => {
      const mockPipeline = {
        triggerSummarization: vi.fn().mockRejectedValue(new Error('SMR service down')),
      };
      const pluginManager = createMockPluginManager({
        getKnowledgePipeline: vi.fn(() => mockPipeline),
      });
      setupStore({ pluginManager });

      const { result } = renderHook(() => useArca());

      await expect(
        act(async () => { await result.current.pipelines.triggerSummarization(); }),
      ).rejects.toThrow('SMR service down');
    });
  });
});

// ===========================================================================
// CONTEXT ERROR PATHS
// ===========================================================================

describe('useArca — context error paths', () => {
  function mockFetchReject() {
    mockFetch.mockRejectedValueOnce(new TypeError('Network error'));
  }

  it('addCaseNote sets context error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.context.addCaseNote('note'); }),
    ).rejects.toThrow();

    expect(mockStoreData.setContextError).toHaveBeenCalled();
  });

  it('addTranscription sets context error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.context.addTranscription('text'); }),
    ).rejects.toThrow();

    expect(mockStoreData.setContextError).toHaveBeenCalled();
  });

  it('updateItem sets context error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.context.updateItem('id', 'content'); }),
    ).rejects.toThrow();

    expect(mockStoreData.setContextError).toHaveBeenCalled();
  });

  it('loadSharedContext sets context error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.context.loadSharedContext(); }),
    ).rejects.toThrow();

    expect(mockStoreData.setContextError).toHaveBeenCalled();
  });

  it('extractEntities sets context error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.context.extractEntities(); }),
    ).rejects.toThrow();

    expect(mockStoreData.setContextError).toHaveBeenCalled();
  });

  it('getContextVersions rethrows error', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.context.getContextVersions('id'); }),
    ).rejects.toThrow();
  });

  it('triggerEntityExtraction rethrows error', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.context.triggerEntityExtraction('id'); }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// SUMMARY ERROR PATHS
// ===========================================================================

describe('useArca — summary error paths', () => {
  function mockFetchReject() {
    mockFetch.mockRejectedValueOnce(new TypeError('Network error'));
  }

  it('generatePreSummary sets summary error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.generatePreSummary(); }),
    ).rejects.toThrow();

    expect(mockStoreData.setSummaryError).toHaveBeenCalled();
  });

  it('generateSummary sets summary error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.generateSummary(); }),
    ).rejects.toThrow();

    expect(mockStoreData.setSummaryError).toHaveBeenCalled();
  });

  it('updateSummary sets summary error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.updateSummary('id', 'content'); }),
    ).rejects.toThrow();

    expect(mockStoreData.setSummaryError).toHaveBeenCalled();
  });

  it('generateSummaryAsync sets summary error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.generateSummaryAsync(); }),
    ).rejects.toThrow();

    expect(mockStoreData.setSummaryError).toHaveBeenCalled();
  });

  it('generatePreSummaryAsync sets summary error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.generatePreSummaryAsync(); }),
    ).rejects.toThrow();

    expect(mockStoreData.setSummaryError).toHaveBeenCalled();
  });

  it('generateComprehensiveSummary sets summary error on failure', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.generateComprehensiveSummary(); }),
    ).rejects.toThrow();

    expect(mockStoreData.setSummaryError).toHaveBeenCalled();
  });

  it('getLatestPreSummary rethrows error', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.getLatestPreSummary(); }),
    ).rejects.toThrow();
  });

  it('getSummaryHistory rethrows error', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.getSummaryHistory('id'); }),
    ).rejects.toThrow();
  });

  it('compareSummaryVersions rethrows error', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.compareSummaryVersions('ctx', 1, 2); }),
    ).rejects.toThrow();
  });

  it('loadSummaries rethrows error', async () => {
    mockFetchReject();

    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.loadSummaries(); }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// LATEST SUMMARY / PRE-SUMMARY SELECTORS
// ===========================================================================

describe('useArca — latestSummary / latestPreSummary selectors', () => {
  it('should expose latestSummary from summaries store', () => {
    const summaries = [
      createMockSummary({ id: 'ps-1', type: 'pre_summary' }),
      createMockSummary({ id: 'sum-1', type: 'summary', content: 'Final summary' }),
    ];
    setupStore({ summaries });

    const { result } = renderHook(() => useArca());

    expect(result.current.summary.summary).toBeTruthy();
    expect(result.current.summary.summary?.id).toBe('sum-1');
  });

  it('should expose latestPreSummary from summaries store', () => {
    const summaries = [
      createMockSummary({ id: 'ps-1', type: 'pre_summary', content: 'Pre-summary text' }),
      createMockSummary({ id: 'sum-1', type: 'summary' }),
    ];
    setupStore({ summaries });

    const { result } = renderHook(() => useArca());

    expect(result.current.summary.preSummary).toBeTruthy();
    expect(result.current.summary.preSummary?.id).toBe('ps-1');
  });

  it('should return null when no matching summary type exists', () => {
    setupStore({ summaries: [] });

    const { result } = renderHook(() => useArca());

    expect(result.current.summary.summary).toBeNull();
    expect(result.current.summary.preSummary).toBeNull();
  });
});

// ===========================================================================
// analyzeDNA — deprecated
// ===========================================================================

describe('useArca — analyzeDNA', () => {
  it('should throw immediately since no backend exists', async () => {
    const { result } = renderHook(() => useArca());

    await expect(
      act(async () => { await result.current.summary.analyzeDNA(['text']); }),
    ).rejects.toThrow('DNA analysis is not supported');
  });
});
