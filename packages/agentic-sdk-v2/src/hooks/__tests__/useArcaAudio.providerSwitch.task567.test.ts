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

  it('forwards startOn to the plugin manager runtime options and marks the active pipeline as fallback (TASK-586)', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ pipelineId: 'primary', startOn: 'fallback' });
    });

    // Pre-start selection threaded into the streaming transport build.
    expect(mockStoreData.pluginManager.setRuntimeOptions).toHaveBeenCalledWith(
      expect.objectContaining({ startOn: 'fallback' }),
    );
    // And the durable active-pipeline flag reflects it from frame 1.
    expect(mockStoreData.setActivePipeline).toHaveBeenCalledWith({
      id: 'primary',
      name: 'primary',
      isFallback: true,
    });
  });

  it('defaults the active pipeline to primary (isFallback false) when startOn is omitted (TASK-586)', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ pipelineId: 'primary' });
    });

    expect(mockStoreData.pluginManager.setRuntimeOptions).toHaveBeenCalledWith(
      expect.objectContaining({ startOn: undefined }),
    );
    expect(mockStoreData.setActivePipeline).toHaveBeenCalledWith({
      id: 'primary',
      name: 'primary',
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

  // ---------------------------------------------------------------------------
  // TASK-614 D-1/D-2/D-3 — `activePipeline` is SERVER-derived.
  //
  // It used to be an echo of `options.pipelineId`, which is silent about the
  // three ways the running engine differs from the requested one: no pipelineId
  // sent at all (gateway resolves), `startOn: 'fallback'`, and a primary ASR
  // that failed to load at create. The first of those left `activePipeline`
  // null for the WHOLE session — the state every switch consumer reads.
  // ---------------------------------------------------------------------------
  it('takes the active pipeline from the session-create echo, not the request', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ pipelineId: 'requested-pipe' });
      const callbacks = mockStoreData.pluginManager.setCallbacks.mock.calls[0]?.[0];
      callbacks.onStreamingSessionCreated?.({ pipelineId: 'resolved-pipe', isFallback: false });
    });

    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith({
      id: 'resolved-pipe',
      name: 'resolved-pipe',
      isFallback: false,
    });
  });

  it('yields a non-null active pipeline for a session started with NO pipelineId', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({});
      const callbacks = mockStoreData.pluginManager.setCallbacks.mock.calls[0]?.[0];
      callbacks.onStreamingSessionCreated?.({ pipelineId: 'gateway-default', isFallback: false });
    });

    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith({
      id: 'gateway-default',
      name: 'gateway-default',
      isFallback: false,
    });
  });

  it('reports isFallback from frame 0 when the server opened on the fallback', async () => {
    // Covers BOTH create-time cases: the user's `startOn: 'fallback'` and a
    // primary ASR that failed to load — the client can't tell them apart and
    // does not need to.
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ pipelineId: 'requested-pipe' });
      const callbacks = mockStoreData.pluginManager.setCallbacks.mock.calls[0]?.[0];
      callbacks.onStreamingSessionCreated?.({ pipelineId: 'tenant-fallback', isFallback: true });
    });

    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith({
      id: 'tenant-fallback',
      name: 'tenant-fallback',
      isFallback: true,
    });
  });

  it('degrades to the request-derived value against a gateway that never echoes', async () => {
    // Mixed-version guard: a new SDK on an older backend must keep working
    // exactly as it did, not throw and not null out.
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ pipelineId: 'requested-pipe' });
    });

    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith({
      id: 'requested-pipe',
      name: 'requested-pipe',
      isFallback: false,
    });
  });

  // ---------------------------------------------------------------------------
  // TASK-614 D-4 — the direction of a switch is READ, not guessed.
  //
  // The handler used to assume `isFallback = true` whenever the frame carried
  // neither `is_fallback` nor `active`. The bridge dropped both fields, so that
  // guess ran on EVERY switch — including the ones going back to the selected
  // pipeline, which therefore stayed latched as "on the tenant default".
  // ---------------------------------------------------------------------------
  it('un-latches on an explicit primary-direction frame', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'primary' });
    });
    const callbacks = mockStoreData.pluginManager.setCallbacks.mock.calls[0]?.[0];

    act(() =>
      callbacks.onProviderSwitched({ fromPipeline: 'sarvam', toPipeline: 'primary', reason: 'user', active: 'primary', isFallback: false }),
    );

    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith({ id: 'primary', name: 'primary', isFallback: false });
    expect(mockStoreData.setSttConnectionState).toHaveBeenLastCalledWith('connected');
  });

  it('infers the direction from the pipeline id when a legacy backend sends neither field', async () => {
    // Pre-586 backend: no `active`, no `is_fallback`. We still know which
    // pipeline this session asked for, and the frame names the one now live —
    // so a switch whose target IS the requested pipeline is a return to
    // primary, never a fallback. Guessing `true` here is what stuck the toggle.
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'arcaai_ml_en' });
    });
    const callbacks = mockStoreData.pluginManager.setCallbacks.mock.calls[0]?.[0];

    act(() => callbacks.onProviderSwitched({ fromPipeline: 'sarvam', toPipeline: 'arcaai_ml_en', reason: 'user' }));

    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith({ id: 'arcaai_ml_en', name: 'arcaai_ml_en', isFallback: false });
    expect(mockStoreData.setSttConnectionState).toHaveBeenLastCalledWith('connected');
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
