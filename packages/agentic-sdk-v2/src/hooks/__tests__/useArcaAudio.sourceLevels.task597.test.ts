/**
 * useArcaAudio — PER-SOURCE input levels + `drainTimeoutMs` threading
 * (TASK-597 open follow-ups #2 and #4).
 *
 * #2. Before this change the SDK exposed exactly ONE level meter, on the mixed
 *     capture graph, so a consumer could know "someone is speaking" but never
 *     "mic 2 is speaking" — which is precisely the attribution the console's
 *     auto-tag feature is about. The fix taps each source inside the mixer.
 *     The properties pinned here are the ones a consumer reasons about:
 *       - N sources  → N levels, index-aligned with the RESOLVED source order;
 *       - 1 source   → exactly one level (that source IS the whole mix);
 *       - no signal  → `[]`, never a guess;
 *       - no capture session outlives its meters (stop AND failed start).
 *
 * #4. `drainTimeoutMs` reaches the transport, and a non-positive value is
 *     dropped rather than forwarded as "close instantly".
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type LevelListener = (levels: { id: string; level: number }[]) => void;

const roomMocks = vi.hoisted(() => {
  const startLevelMonitoring = vi.fn();
  const stopLevelMonitoring = vi.fn();
  const dispose = vi.fn();
  /** Flipped by a test to simulate a runtime that cannot analyse. */
  const state = { monitoringSupported: true, listener: null as LevelListener | null };

  class MockAudioMixer {
    private readonly held: { stream: { getTracks(): { stop(): void }[] } }[] = [];
    addSource = (_id: string, stream: any) => {
      this.held.push({ stream });
    };
    startLevelMonitoring = (options?: { intervalMs?: number; onLevels?: LevelListener }) => {
      startLevelMonitoring(options);
      if (!state.monitoringSupported) return false;
      state.listener = options?.onLevels ?? null;
      return true;
    };
    stopLevelMonitoring = () => {
      state.listener = null;
      stopLevelMonitoring();
    };
    getMixedTrack = () => ({ kind: 'audio', label: 'mixed-track' });
    dispose = () => {
      state.listener = null;
      this.held.forEach((s) => s.stream.getTracks().forEach((t: { stop(): void }) => t.stop()));
      this.held.length = 0;
      dispose();
    };
  }

  const acquire = vi.fn();
  const getInstance = vi.fn(() => ({ acquire }));

  return { startLevelMonitoring, stopLevelMonitoring, dispose, state, MockAudioMixer, acquire, getInstance };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return {
    ...actual,
    AudioMixer: roomMocks.MockAudioMixer,
    AudioContextManager: { getInstance: roomMocks.getInstance },
  };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({
  useAgenticStore: vi.fn(() => mockStoreData),
}));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeStream(label: string) {
  const track = {
    kind: 'audio',
    label,
    enabled: true,
    readyState: 'live' as 'live' | 'ended',
    stop: vi.fn(function () {
      track.readyState = 'ended';
    }),
  };
  return { label, getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

/**
 * An AudioContext whose analyser emits a controllable constant amplitude — the
 * single-source meter path runs through this, so the published level is
 * deterministic instead of "whatever a real mic hears".
 */
function makeAudioContext() {
  const analyser = {
    fftSize: 512,
    smoothingTimeConstant: 0,
    amplitude: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(analyser.amplitude),
  };
  const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
  return {
    analyser,
    ctx: {
      sampleRate: 48000,
      createAnalyser: vi.fn(() => analyser),
      createMediaStreamSource: vi.fn(() => sourceNode),
    },
  };
}

function createMockPluginManager(overrides: Record<string, any> = {}) {
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
    getTranscriptionPipeline: vi.fn(() => null),
    getKnowledgePipeline: vi.fn(() => null),
    ...overrides,
  };
}

function setupStore(overrides: Record<string, any> = {}) {
  mockStoreData = {
    pluginManager: createMockPluginManager(),
    consultation: { id: 'cons-1' },
    apiClient: null,
    logger: null,
    preferences: {},

    isCapturing: false,
    isMuted: false,
    audioLevel: 0,
    audioSourceLevels: [],
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

    setIsCapturing: vi.fn(),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setAudioSourceLevels: vi.fn(),
    setIsSpeaking: vi.fn(),
    setCurrentTranscript: vi.fn(),
    setAudioLanguage: vi.fn(),
    setSttLanguageMode: vi.fn(),
    setAudioPlugins: vi.fn(),
    setAudioError: vi.fn(),
    setActiveStream: vi.fn((s: unknown) => {
      mockStoreData.activeStream = s;
    }),
    setActiveAudioContext: vi.fn(),
    setSttConnectionState: vi.fn(),
    setActivePipeline: vi.fn(),
    setAudioUplinkBitrate: vi.fn(),
    addTranscriptSegment: vi.fn(),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
    resetAudioDropped: vi.fn(),
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
    ...overrides,
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
  return mockStoreData;
}

let audioCtx: ReturnType<typeof makeAudioContext>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  roomMocks.state.monitoringSupported = true;
  roomMocks.state.listener = null;
  audioCtx = makeAudioContext();
  roomMocks.acquire.mockResolvedValue(audioCtx.ctx);
  setupStore();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ===========================================================================
// #2 — per-source levels
// ===========================================================================
describe('useArcaAudio — per-source levels (multi-source)', () => {
  it('starts mixer level monitoring and publishes ONE level per source, in resolved order', async () => {
    const streams = ['mic-A', 'mic-B', 'mic-C'].map(makeStream);
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    streams.forEach((s) => getUserMedia.mockResolvedValueOnce(s));
    const store = setupStore();

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B', additionalDeviceIds: ['mic-C'] });
    });

    expect(roomMocks.startLevelMonitoring).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 100 }));

    // The mixer reports per-source levels; the hook flattens them to an array
    // whose INDEX is the resolved source position — the same index
    // `sourceGains` uses, so a consumer can line them up with its own list.
    act(() => {
      roomMocks.state.listener?.([
        { id: 'source-1', level: 4 },
        { id: 'source-2', level: 71 },
        { id: 'source-3', level: 0 },
      ]);
    });
    expect(store.setAudioSourceLevels).toHaveBeenLastCalledWith([4, 71, 0]);
  });

  it('leaves the MIXED level untouched — multi-source mixing does not repurpose `level`', async () => {
    const streams = ['mic-A', 'mic-B'].map(makeStream);
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    streams.forEach((s) => getUserMedia.mockResolvedValueOnce(s));
    const store = setupStore();

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });

    audioCtx.analyser.amplitude = 0.2;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // The mixed meter still publishes the mixed level…
    expect(store.setAudioLevel).toHaveBeenCalledWith(50);
    // …and does NOT masquerade as a per-source array: with several sources the
    // mixer owns that channel, so the only per-source write is the explicit
    // start-time one (see the unsupported-runtime test for what that is).
    const perSourceWrites = (store.setAudioSourceLevels as any).mock.calls.filter((c: unknown[]) => Array.isArray(c[0]) && (c[0] as []).length > 0);
    expect(perSourceWrites).toEqual([]);
  });

  it('publishes `[]` when the runtime cannot analyse — no attribution is better than a fake one', async () => {
    roomMocks.state.monitoringSupported = false;
    const streams = ['mic-A', 'mic-B'].map(makeStream);
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    streams.forEach((s) => getUserMedia.mockResolvedValueOnce(s));
    const store = setupStore();

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });

    expect(store.setAudioSourceLevels).toHaveBeenCalledWith([]);
  });
});

describe('useArcaAudio — per-source levels (single source)', () => {
  it('publishes a ONE-entry array from the capture meter: that source IS the whole mix', async () => {
    const store = setupStore();
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start();
    });

    // No mixer at all on the single-source path — nothing to tap per source.
    expect(roomMocks.startLevelMonitoring).not.toHaveBeenCalled();

    audioCtx.analyser.amplitude = 0.2;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(store.setAudioLevel).toHaveBeenLastCalledWith(50);
    expect(store.setAudioSourceLevels).toHaveBeenLastCalledWith([50]);
  });
});

describe('useArcaAudio — per-source meters never outlive the capture session', () => {
  it('stop() clears the levels in the SAME synchronous block that releases the mic', async () => {
    const streams = ['mic-A', 'mic-B'].map(makeStream);
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    streams.forEach((s) => getUserMedia.mockResolvedValueOnce(s));
    const store = setupStore({
      pluginManager: createMockPluginManager({
        // A drain that never settles: the assertions below must hold BEFORE it
        // resolves, or a stale "mic 2 is speaking" would be readable for the
        // whole drain window.
        destroy: vi.fn(() => new Promise<void>(() => {})),
      }),
    });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });
    (store.setAudioSourceLevels as any).mockClear();

    act(() => {
      void result.current.stop();
    });

    expect(store.setAudioSourceLevels).toHaveBeenCalledWith([]);
    // dispose() is the mixer's own teardown of the analyser taps + timer.
    expect(roomMocks.dispose).toHaveBeenCalled();
  });

  it('a FAILED start releases the level meter — no timer keeps ticking against a dead graph', async () => {
    const store = setupStore({
      pluginManager: createMockPluginManager({
        initialize: vi.fn().mockRejectedValue(new Error('pipeline boom')),
      }),
    });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await expect(result.current.start()).rejects.toThrow('pipeline boom');
    });

    expect(store.setAudioSourceLevels).toHaveBeenLastCalledWith([]);
    (store.setAudioLevel as any).mockClear();
    (store.setAudioSourceLevels as any).mockClear();

    audioCtx.analyser.amplitude = 0.4;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Ten poll periods after the rejection: silence. Before the fix the meter
    // interval survived the throw and published forever.
    expect(store.setAudioLevel).not.toHaveBeenCalled();
    expect(store.setAudioSourceLevels).not.toHaveBeenCalled();
  });

  it('a failed MULTI-source start stops mixer level monitoring too', async () => {
    const streams = ['mic-A', 'mic-B'].map(makeStream);
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    streams.forEach((s) => getUserMedia.mockResolvedValueOnce(s));
    setupStore({
      pluginManager: createMockPluginManager({
        initialize: vi.fn().mockRejectedValue(new Error('pipeline boom')),
      }),
    });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await expect(result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' })).rejects.toThrow('pipeline boom');
    });

    expect(roomMocks.stopLevelMonitoring).toHaveBeenCalled();
  });
});

// ===========================================================================
// #4 — drainTimeoutMs threading
// ===========================================================================
describe('useArcaAudio — drainTimeoutMs (TASK-597 follow-up #4)', () => {
  it('forwards a positive drainTimeoutMs to the plugin manager runtime options', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1', drainTimeoutMs: 800 });
    });

    expect(pluginManager.setRuntimeOptions).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'pipe-1', drainTimeoutMs: 800 }));
  });

  it.each([0, -1, Number.NaN])('IGNORES a non-positive drainTimeoutMs (%p) rather than forwarding it', async (value) => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1', drainTimeoutMs: value });
    });

    // `0` must not read as "close instantly" and NaN must not reach a setTimeout.
    expect(pluginManager.setRuntimeOptions.mock.calls[0][0]).not.toHaveProperty('drainTimeoutMs');
  });

  it('omits the field entirely when the caller does not set it (pre-597 options object)', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1' });
    });

    expect(pluginManager.setRuntimeOptions.mock.calls[0][0]).not.toHaveProperty('drainTimeoutMs');
  });
});

// ===========================================================================
// quietWindowMs threading (TASK-597)
//
// The guard here is `>= 0`, deliberately UNLIKE `drainTimeoutMs` above. `0` is
// the documented "disable the early resolve and wait for the terminal status"
// value, so it must reach the plugin manager rather than be swallowed by a
// truthiness check copied from the timeout knob.
// ===========================================================================
describe('useArcaAudio — quietWindowMs (TASK-597)', () => {
  it('PRESERVES quietWindowMs: 0 through setRuntimeOptions', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1', quietWindowMs: 0 });
    });

    expect(pluginManager.setRuntimeOptions.mock.calls[0][0]).toHaveProperty('quietWindowMs', 0);
  });

  it('forwards a positive quietWindowMs', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1', quietWindowMs: 2000 });
    });

    expect(pluginManager.setRuntimeOptions.mock.calls[0][0]).toHaveProperty('quietWindowMs', 2000);
  });

  it.each([-1, Number.NaN])('drops a meaningless quietWindowMs (%p)', async (value) => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1', quietWindowMs: value });
    });

    expect(pluginManager.setRuntimeOptions.mock.calls[0][0]).not.toHaveProperty('quietWindowMs');
  });

  it('omits the field entirely when the caller does not set it (pre-597 options object)', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1' });
    });

    expect(pluginManager.setRuntimeOptions.mock.calls[0][0]).not.toHaveProperty('quietWindowMs');
  });
});
