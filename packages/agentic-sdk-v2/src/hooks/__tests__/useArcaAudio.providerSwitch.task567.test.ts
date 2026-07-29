/**
 * useArcaAudio — streaming STT connection state + provider switch (TASK-567 Phase F).
 *
 * Locks the hook's role in surfacing the streaming connection lifecycle and the
 * on-the-fly fallback switch (R4):
 *   - start() records the active backend pipeline and resets the connection state;
 *   - it wires `onSttConnectionState` / `onProviderSwitched` into the plugin
 *     callbacks and maps them onto the store;
 *   - `switchToFallback()` drives the session manager's in-place switch, and
 *     falls back to a destroy/recreate rebuild on a 404 (older backend);
 *   - `sttConnectionState` / `activePipeline` are read back from the store.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const roomMocks = vi.hoisted(() => {
  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  const getInstance = vi.fn(() => ({ acquire }));
  return { acquire, getInstance };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return {
    ...actual,
    AudioContextManager: { getInstance: roomMocks.getInstance },
  };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => mockStoreData),
}));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, stop: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

/** A streaming session manager mock reachable through the transcription pipeline. */
function makeSessionManager(overrides: Record<string, any> = {}) {
  return {
    getSessionId: vi.fn(() => 'sess-1'),
    switchToFallback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockPluginManager(sessionManager: ReturnType<typeof makeSessionManager> | null, overrides: Record<string, any> = {}) {
  return {
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
    getTranscriptionPipeline: vi.fn(() => (sessionManager ? { getStreamingSessionManager: () => sessionManager } : null)),
    getKnowledgePipeline: vi.fn(() => null),
    ...overrides,
  };
}

function setupStore(overrides: Record<string, any> = {}, sessionManager: ReturnType<typeof makeSessionManager> | null = makeSessionManager()) {
  mockStoreData = {
    pluginManager: createMockPluginManager(sessionManager),
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
    audioUplinkBitrate: 0,
    sttConnectionState: 'connected',
    activePipeline: null,

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
    setAudioUplinkBitrate: vi.fn(),
    setSttConnectionState: vi.fn(),
    setActivePipeline: vi.fn(),
    ...overrides,
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
  return mockStoreData;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupStore();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useArcaAudio — provider switch + connection state (TASK-567)', () => {
  it('exposes sttConnectionState and activePipeline from the store', () => {
    setupStore({ sttConnectionState: 'reconnecting', activePipeline: { id: 'p1', name: 'Primary', isFallback: false } });

    const { result } = renderHook(() => useArcaAudio());

    expect(result.current.sttConnectionState).toBe('reconnecting');
    expect(result.current.activePipeline).toEqual({ id: 'p1', name: 'Primary', isFallback: false });
  });

  it('records the active backend pipeline and a nominal connection state on start', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ pipelineId: 'azure_speech_transcription' });
    });

    expect(mockStoreData.setSttConnectionState).toHaveBeenCalledWith('connected');
    expect(mockStoreData.setActivePipeline).toHaveBeenCalledWith({
      id: 'azure_speech_transcription',
      name: 'azure_speech_transcription',
      isFallback: false,
    });
  });

  it('clears the active pipeline on start with no backend pipeline (local STT)', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });

    expect(mockStoreData.setActivePipeline).toHaveBeenCalledWith(null);
  });

  it('maps onSttConnectionState transitions onto the store', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'p1' });
    });

    const callbacks = mockStoreData.pluginManager.setCallbacks.mock.calls[0]?.[0];
    expect(typeof callbacks?.onSttConnectionState).toBe('function');

    act(() => callbacks.onSttConnectionState('reconnecting'));
    expect(mockStoreData.setSttConnectionState).toHaveBeenCalledWith('reconnecting');

    act(() => callbacks.onSttConnectionState('error'));
    expect(mockStoreData.setSttConnectionState).toHaveBeenCalledWith('error');
  });

  it('maps onProviderSwitched onto switched_fallback + a fallback active pipeline', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'primary' });
    });

    const callbacks = mockStoreData.pluginManager.setCallbacks.mock.calls[0]?.[0];
    expect(typeof callbacks?.onProviderSwitched).toBe('function');

    act(() => callbacks.onProviderSwitched({ fromPipeline: 'primary', toPipeline: 'sarvam_transcription', reason: 'auto', utteranceIndex: 4 }));

    expect(mockStoreData.setSttConnectionState).toHaveBeenCalledWith('switched_fallback');
    expect(mockStoreData.setActivePipeline).toHaveBeenCalledWith({ id: 'sarvam_transcription', name: 'sarvam_transcription', isFallback: true });
  });

  it('switchToFallback drives the session manager in-place switch', async () => {
    const sessionManager = makeSessionManager();
    setupStore({}, sessionManager);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.switchToFallback();
    });

    expect(sessionManager.switchToFallback).toHaveBeenCalledTimes(1);
    // Success is confirmed by the async provider_switched frame — no optimistic write here.
    expect(mockStoreData.setSttConnectionState).not.toHaveBeenCalledWith('switched_fallback');
  });

  it('switchToFallback throws when there is no active streaming session', async () => {
    setupStore({}, makeSessionManager({ getSessionId: vi.fn(() => null) }));

    const { result } = renderHook(() => useArcaAudio());

    await expect(
      act(async () => {
        await result.current.switchToFallback();
      }),
    ).rejects.toThrow(/no active streaming session/i);
  });

  it('degraded path: a 404 with a fallbackPipelineId rebuilds on the fallback', async () => {
    const notFound = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    const sessionManager = makeSessionManager({ switchToFallback: vi.fn().mockRejectedValue(notFound) });
    setupStore({}, sessionManager);

    const { result } = renderHook(() => useArcaAudio());
    // Prime a running session so stop() has something to tear down.
    await act(async () => {
      await result.current.start({ pipelineId: 'primary' });
    });
    const pm = mockStoreData.pluginManager;
    (mockStoreData.setSttConnectionState as any).mockClear();

    await act(async () => {
      await result.current.switchToFallback('fallback_pipeline');
    });

    // Surfaced honestly as reconnecting, then rebuilt (destroy + re-init) and
    // finally marked as the fallback.
    expect(mockStoreData.setSttConnectionState).toHaveBeenCalledWith('reconnecting');
    expect(pm.destroy).toHaveBeenCalled();
    expect(mockStoreData.setActivePipeline).toHaveBeenCalledWith({ id: 'fallback_pipeline', name: 'fallback_pipeline', isFallback: true });
    expect(mockStoreData.setSttConnectionState).toHaveBeenLastCalledWith('switched_fallback');
  });

  it('switchToFallback rethrows a non-404 error and marks the connection errored', async () => {
    const boom = Object.assign(new Error('server exploded'), { code: 'API_ERROR' });
    setupStore({}, makeSessionManager({ switchToFallback: vi.fn().mockRejectedValue(boom) }));

    const { result } = renderHook(() => useArcaAudio());

    await expect(
      act(async () => {
        await result.current.switchToFallback();
      }),
    ).rejects.toThrow(/server exploded/);
    expect(mockStoreData.setSttConnectionState).toHaveBeenCalledWith('error');
  });
});
