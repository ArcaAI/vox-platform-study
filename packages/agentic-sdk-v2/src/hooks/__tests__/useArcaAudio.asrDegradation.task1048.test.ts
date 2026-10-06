/**
 * TASK-1048 — useArcaAudio surfaces ASR session warnings + runtime degradations from the store
 * and feeds the plugin callbacks into it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const roomMocks = vi.hoisted(() => {
  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  return { acquire, getInstance: vi.fn(() => ({ acquire })) };
});
vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return { ...actual, AudioContextManager: { getInstance: roomMocks.getInstance } };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStoreData) }));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

function makeStream() {
  const track = { kind: 'audio', label: 'm', enabled: true, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

function setupStore(overrides: Record<string, any> = {}) {
  const pluginManager = {
    setRuntimeOptions: vi.fn(),
    clearRuntimeOptions: vi.fn(),
    setCallbacks: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    getStates: vi.fn(() => ({
      noiseFilter: { isActive: false, isSupported: true },
      vad: { isActive: true, isSupported: true },
      stt: { isActive: true, isSupported: true, isProcessing: false },
    })),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    getTranscriptionPipeline: vi.fn(() => null),
    getKnowledgePipeline: vi.fn(() => null),
  };
  mockStoreData = {
    pluginManager,
    consultation: { id: 'cons-1' },
    apiClient: null,
    logger: null,
    preferences: {},
    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    isSpeaking: false,
    currentTranscript: '',
    transcriptSegments: [],
    audioLanguage: 'en',
    audioPlugins: {
      noiseFilter: { isActive: false, isSupported: false },
      vad: { isActive: false, isSupported: false },
      stt: { isActive: false, isSupported: false, isProcessing: false },
    },
    audioError: null,
    activeStream: null,
    activeAudioContext: null,
    audioDroppedFrameCount: 0,
    audioLostThisSession: false,
    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioLanguage: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    setActiveStream: vi.fn(),
    setActiveAudioContext: vi.fn(),
    addTranscriptSegment: vi.fn(),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
    resetAudioDropped: vi.fn(),
    setSttConnectionState: vi.fn(),
    setActivePipeline: vi.fn(),
    setSttSessionWarnings: vi.fn(),
    addSttDegradation: vi.fn(),
    ...overrides,
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
  return pluginManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => makeStream()) } });
});
afterEach(() => vi.unstubAllGlobals());

describe('useArcaAudio — ASR warnings & degradations (TASK-1048)', () => {
  it('exposes warnings and degradations from the store, defaulting to []', () => {
    setupStore();
    const { result: empty } = renderHook(() => useArcaAudio());
    expect(empty.current.warnings).toEqual([]);
    expect(empty.current.degradations).toEqual([]);

    const w = [{ code: 'VAD_MODEL_MISSING', stage: 'vad', severity: 'WARNING', message: 'm', agentSlug: 'a' }];
    const d = [{ reason: 'vad_unavailable', at: 5 }];
    setupStore({ sttSessionWarnings: w, sttDegradations: d });
    const { result } = renderHook(() => useArcaAudio());
    expect(result.current.warnings).toBe(w);
    expect(result.current.degradations).toBe(d);
  });

  it('pushes plugin callbacks into the store', async () => {
    const pm = setupStore();
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start();
    });
    const cbs = pm.setCallbacks.mock.calls[0]?.[0];
    const w = [{ code: 'VAD_MODEL_MISSING' }];
    act(() => {
      cbs.onSttSessionWarnings(w);
      cbs.onSttDegraded({ reason: 'lexicon_unavailable', at: 9 });
    });
    expect(mockStoreData.setSttSessionWarnings).toHaveBeenCalledWith(w);
    expect(mockStoreData.addSttDegradation).toHaveBeenCalledWith({ reason: 'lexicon_unavailable', at: 9 });
  });
});
