/**
 * useArcaAudio — caller-owned stream LIFECYCLE (TASK-612 Lane B, RC-3, OD-1a).
 *
 * Before this change every teardown path stopped EVERY track the session had
 * seen — including tracks on `MediaStream`s the CALLER built and injected via
 * `sourceStreams` / `addSource({ stream })`. Stopping those is not cleanup, it
 * is destruction of someone else's object: the integrator's next session
 * reuses the same stream, finds its tracks `ended`, and (since Lane A) gets a
 * named SOURCE_STREAM_NOT_LIVE rejection where reuse should simply work.
 *
 * The ratified contract (OD-1a): ownership is tagged at ingestion — streams
 * the SDK opened via `getUserMedia` are SDK-owned and released exactly as
 * before; injected streams are caller-owned and NEVER stopped by the SDK
 * (nodes are still disconnected; the mixer is told via
 * `stopTracksOnRemove: false`). The caller decides when their stream ends.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — same shape as the other useArcaAudio suites (task597/task609/612A):
// a spy-based AudioMixer double and a directly-swappable store. The mixer spy
// is what lets these tests assert the OWNERSHIP FLAG at the call boundary;
// the real stop-on-remove behavior behind that flag is covered by
// packages/room's AudioMixer.ownership.task612.test.ts.
// ---------------------------------------------------------------------------
const roomMocks = vi.hoisted(() => {
  const addSource = vi.fn();
  const removeSource = vi.fn();
  const startLevelMonitoring = vi.fn(() => true);
  const stopLevelMonitoring = vi.fn();
  const dispose = vi.fn();
  const mixerCtor = vi.fn();

  class MockAudioMixer {
    constructor(ctx: unknown) {
      mixerCtor(ctx);
    }
    addSource = addSource;
    removeSource = removeSource;
    startLevelMonitoring = startLevelMonitoring;
    stopLevelMonitoring = stopLevelMonitoring;
    getMixedTrack = () => ({ kind: 'audio', label: 'mixed-track' });
    dispose = dispose;
  }

  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  const getInstance = vi.fn(() => ({ acquire }));

  return { MockAudioMixer, mixerCtor, addSource, removeSource, startLevelMonitoring, stopLevelMonitoring, dispose, acquire, getInstance };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return { ...actual, AudioMixer: roomMocks.MockAudioMixer, AudioContextManager: { getInstance: roomMocks.getInstance } };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStoreData) }));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

// ---------------------------------------------------------------------------
// Fakes — track doubles whose stop() flips readyState to 'ended', so the
// RC-3 reuse scenario is exercised for real: if any teardown stops a
// caller-owned track, the second start() fails Lane A's liveness validation.
// ---------------------------------------------------------------------------
interface FakeTrack {
  kind: string;
  label: string;
  enabled: boolean;
  readyState: 'live' | 'ended';
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function makeTrack(label: string, readyState: 'live' | 'ended' = 'live'): FakeTrack {
  const track: FakeTrack = {
    kind: 'audio',
    label,
    enabled: true,
    readyState,
    stop: vi.fn(function (this: void) {
      track.readyState = 'ended';
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return track;
}

function makeStream(label: string) {
  const tracks: FakeTrack[] = [makeTrack(label)];
  return { label, getAudioTracks: () => tracks, getTracks: () => tracks, _tracks: tracks };
}

function createMockPluginManager(overrides: Record<string, any> = {}) {
  return {
    initialized: false,
    setRuntimeOptions: vi.fn(),
    clearRuntimeOptions: vi.fn(),
    setCallbacks: vi.fn(),
    initialize: vi.fn(async function (this: any) {
      this.initialized = true;
    }),
    destroy: vi.fn(async function (this: any) {
      this.initialized = false;
    }),
    getStates: vi.fn(() => ({
      noiseFilter: { isActive: false, isSupported: true },
      vad: { isActive: false, isSupported: true },
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
    audioSourceIds: [],
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

    setIsCapturing: vi.fn((v: boolean) => {
      mockStoreData.isCapturing = v;
    }),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
    setAudioSourceLevels: vi.fn(),
    setAudioSourceIds: vi.fn((ids: string[]) => {
      mockStoreData.audioSourceIds = ids;
    }),
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

let defaultGumStream: ReturnType<typeof makeStream>;

beforeEach(() => {
  vi.clearAllMocks();
  setupStore();
  defaultGumStream = makeStream('gum-default');
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => defaultGumStream) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// stop() — ownership decides which tracks are released
// ===========================================================================
describe('useArcaAudio — caller-owned stream lifecycle (TASK-612 Lane B)', () => {
  it('(1) stop() leaves a caller-injected single source LIVE — the activeStream teardown honors ownership', async () => {
    const injected = makeStream('external-mic');
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: [injected as unknown as MediaStream] });
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(injected._tracks[0]!.stop).not.toHaveBeenCalled();
    expect(injected._tracks[0]!.readyState).toBe('live');
    // The session itself still fully tears down.
    expect(mockStoreData.setActiveStream).toHaveBeenLastCalledWith(null);
    expect(mockStoreData.setIsCapturing).toHaveBeenLastCalledWith(false);
  });

  it('(2) RC-3 reuse: the SAME injected stream starts again after stop()', async () => {
    const injected = makeStream('external-mic');
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: [injected as unknown as MediaStream] });
    });
    await act(async () => {
      await result.current.stop();
    });
    // Pre-fix this rejected SOURCE_STREAM_NOT_LIVE: stop() had ended the
    // caller's track, so Lane A's validation (correctly) refused the corpse.
    await act(async () => {
      await result.current.start({ sourceStreams: [injected as unknown as MediaStream] });
    });

    expect(pluginManager.initialize).toHaveBeenCalledTimes(2);
  });

  it('(3) a getUserMedia-acquired stream is still released exactly once on stop()', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(defaultGumStream._tracks[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('(4a) a FAILED start never stops caller-owned tracks', async () => {
    const injected = makeStream('external-mic');
    const pluginManager = createMockPluginManager({
      initialize: vi.fn(async () => {
        throw new Error('pipeline init failed');
      }),
    });
    setupStore({ pluginManager });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await expect(result.current.start({ sourceStreams: [injected as unknown as MediaStream] })).rejects.toThrow('pipeline init failed');
    });

    expect(injected._tracks[0]!.stop).not.toHaveBeenCalled();
    expect(injected._tracks[0]!.readyState).toBe('live');
  });

  it('(4b) a FAILED start still releases SDK-owned (getUserMedia) tracks', async () => {
    const pluginManager = createMockPluginManager({
      initialize: vi.fn(async () => {
        throw new Error('pipeline init failed');
      }),
    });
    setupStore({ pluginManager });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await expect(result.current.start()).rejects.toThrow('pipeline init failed');
    });

    expect(defaultGumStream._tracks[0]!.stop).toHaveBeenCalled();
  });

  it('(5) a multi-injected mixer session registers every source caller-owned and stop() leaves all tracks live', async () => {
    const s1 = makeStream('room-mic');
    const s2 = makeStream('lapel-mic');
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: [s1, s2] as unknown as MediaStream[] });
    });

    expect(roomMocks.addSource).toHaveBeenCalledWith(expect.any(String), s1, 1, { stopTracksOnRemove: false });
    expect(roomMocks.addSource).toHaveBeenCalledWith(expect.any(String), s2, 1, { stopTracksOnRemove: false });

    await act(async () => {
      await result.current.stop();
    });

    expect(roomMocks.dispose).toHaveBeenCalled();
    expect(s1._tracks[0]!.stop).not.toHaveBeenCalled();
    expect(s2._tracks[0]!.stop).not.toHaveBeenCalled();
  });

  it('(6) runtime addSource: a caller stream registers caller-owned, a deviceId registers SDK-owned', async () => {
    const s1 = makeStream('external-mic');
    const late = makeStream('late-caller-mic');
    const usb = makeStream('usb-array');
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(usb);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ sourceStreams: [s1 as unknown as MediaStream], dynamicSources: true });
    });

    await act(async () => {
      await result.current.addSource({ stream: late as unknown as MediaStream });
    });
    expect(roomMocks.addSource).toHaveBeenLastCalledWith(expect.any(String), late, 1, { stopTracksOnRemove: false });

    await act(async () => {
      await result.current.addSource({ deviceId: 'usb-array' });
    });
    expect(roomMocks.addSource).toHaveBeenLastCalledWith(expect.any(String), usb, 1, { stopTracksOnRemove: true });

    // On stop(): the SDK-owned late join is released by the teardown loop
    // (the mixer double stops nothing, so the hook loop is what's measured);
    // both caller-owned streams stay live.
    await act(async () => {
      await result.current.stop();
    });
    expect(usb._tracks[0]!.stop).toHaveBeenCalled();
    expect(late._tracks[0]!.stop).not.toHaveBeenCalled();
    expect(s1._tracks[0]!.stop).not.toHaveBeenCalled();
  });
});
