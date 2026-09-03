/**
 * useArcaAudio — silent-uplink watchdog.
 *
 * A session can stream STRUCTURALLY VALID frames of pure zeros — a wrong or
 * default microphone, a muted-at-OS device, a caller's suspended
 * AudioContext behind an injected stream, or browser echo-cancellation/
 * noise-suppression/AGC zeroing a virtual device — and nothing detects it:
 * the integrator just watches an open socket carrying silence. The
 * session-level meter already computes RMS every 100 ms (see `startAudio`'s
 * "Live input-level meter" block); this watchdog rides that SAME tick
 * instead of a second timer.
 *
 * Harness copied from `task612-caller-owned-streams.test.ts`, extended with a
 * fake AudioContext (`createMediaStreamSource` / `createAnalyser`) so the
 * meter block actually arms — the caller-owned-streams harness stubs
 * `acquire()` down to `{ sampleRate: 48000 }`, which fails the meter's own
 * feature-detection guard and leaves it permanently unarmed. Also extended
 * with a real logger double (that harness uses `logger: null`, relying on
 * optional chaining) so `logger.warn` is observable here.
 *
 * TASK-865: streaming sessions are started with `agentSlug` (the supported
 * selector); `pipelineId` now also emits a deprecation warning, which would
 * otherwise be counted here.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — same shape as the other useArcaAudio suites (task597/task609/612A/B):
// a spy-based AudioMixer double and a directly-swappable store.
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

  const acquire = vi.fn();
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
// Fakes
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

/**
 * An AudioContext whose analyser emits a controllable constant sample — the
 * watchdog rides the SAME per-100ms RMS tick the meter publishes, so driving
 * this fake's `currentSample` between 0 (silence) and a non-zero value
 * (signal) is how each scenario below is scripted. `0.2` reproduces the
 * level-50 case already pinned by `useArcaAudio.sourceLevels.task597.test.ts`
 * (`rms * 250`, clamped to 100).
 */
function makeAudioContext() {
  const analyser = {
    fftSize: 512,
    smoothingTimeConstant: 0,
    currentSample: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(analyser.currentSample),
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

/** Logger double whose `child()` returns itself, so `warn` is one spy to assert on. */
function makeLoggerDouble() {
  const logger: any = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    startOperation: vi.fn(() => ({ end: vi.fn(), error: vi.fn() })),
  };
  logger.child = vi.fn(() => logger);
  return logger;
}

function setupStore(overrides: Record<string, any> = {}) {
  mockStoreData = {
    pluginManager: createMockPluginManager(),
    consultation: { id: 'cons-1' },
    apiClient: null,
    logger: makeLoggerDouble(),
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
    setAudioSignalState: vi.fn(),
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
let audioCtx: ReturnType<typeof makeAudioContext>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  audioCtx = makeAudioContext();
  roomMocks.acquire.mockResolvedValue(audioCtx.ctx);
  setupStore();
  defaultGumStream = makeStream('gum-default');
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => defaultGumStream) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useArcaAudio — silent-uplink watchdog', () => {
  it('(a) streaming session + 5s of zero-level ticks -> setAudioSignalState("silent") once + one logger.warn', async () => {
    const store = setupStore();
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'asr-1' });
    });

    audioCtx.analyser.currentSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(store.setAudioSignalState.mock.calls.filter((c: unknown[]) => c[0] === 'silent')).toHaveLength(1);
    expect(store.logger.warn).toHaveBeenCalledTimes(1);
    expect(store.logger.warn.mock.calls[0][0]).toMatch(/mic|device|AudioContext|echo|noise|AGC/i);
  });

  it('(b) still silent for another 5s -> NO second warn (episode latch)', async () => {
    const store = setupStore();
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'asr-1' });
    });

    audioCtx.analyser.currentSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(store.logger.warn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(store.logger.warn).toHaveBeenCalledTimes(1);
    expect(store.setAudioSignalState.mock.calls.filter((c: unknown[]) => c[0] === 'silent')).toHaveLength(1);
  });

  it('(c) signal returns -> setAudioSignalState("ok"); a LATER silent 5s fires a NEW warn', async () => {
    const store = setupStore();
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'asr-1' });
    });

    audioCtx.analyser.currentSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(store.logger.warn).toHaveBeenCalledTimes(1);

    audioCtx.analyser.currentSample = 0.2;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(store.setAudioSignalState).toHaveBeenLastCalledWith('ok');

    audioCtx.analyser.currentSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(store.logger.warn).toHaveBeenCalledTimes(2);
    expect(store.setAudioSignalState.mock.calls.filter((c: unknown[]) => c[0] === 'silent')).toHaveLength(2);
  });

  it('(d) non-streaming session (no pipelineId) never fires', async () => {
    const store = setupStore();
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });

    audioCtx.analyser.currentSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(store.setAudioSignalState).not.toHaveBeenCalledWith('silent');
    expect(store.logger.warn).not.toHaveBeenCalled();
  });

  it('(e) muted session never fires', async () => {
    const store = setupStore({ isMuted: true });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'asr-1' });
    });

    audioCtx.analyser.currentSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(store.setAudioSignalState).not.toHaveBeenCalledWith('silent');
    expect(store.logger.warn).not.toHaveBeenCalled();
  });

  it('(f) stop() during silence clears the timer — no further calls once stopped', async () => {
    const store = setupStore();
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ agentSlug: 'asr-1' });
    });

    audioCtx.analyser.currentSample = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(store.logger.warn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.stop();
    });
    const signalCallsAfterStop = store.setAudioSignalState.mock.calls.length;
    const warnCallsAfterStop = store.logger.warn.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(store.setAudioSignalState.mock.calls.length).toBe(signalCallsAfterStop);
    expect(store.logger.warn.mock.calls.length).toBe(warnCallsAfterStop);
  });
});
