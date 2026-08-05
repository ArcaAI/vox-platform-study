/**
 * useArcaAudio — start-race dropped capture options become a surfaced error
 * (TASK-612 Lane C, RC-2, OD-2a).
 *
 * The CALL-TIME idempotence guard in `startAudio` (TASK-597 follow-up) exists
 * because the compat layer drives ONE audio graph through TWO hooks
 * (`useAudioCapture.startRecording` and `useArcaSpeechToText.startTranscription`),
 * each guarded only by a RENDER-TIME `isCapturing` snapshot. When both land in
 * `startAudio` while `pluginManager.initialized` is already `true`, the SECOND
 * call is ignored. Before this fix, if that ignored call carried
 * capture-shaped options (`deviceId`, `sourceStreams`, `dynamicSources`, ...),
 * the hook only `logger.warn`'d — the caller's `await start(...)` resolved
 * successfully, so an integrator whose STT hook won the start race streamed
 * the default mic with ZERO surfaced error (the literal "UI shows my external
 * mic selected but the socket carries the built-in one" bug, RC-2).
 *
 * The fix: a call that drops capture-shaped options still `logger.warn`s (log
 * triage stays) and now ALSO throws a named `AgenticError`
 * ('CAPTURE_OPTIONS_DROPPED') naming every dropped key, so the calling hook's
 * existing catch → setError/onError path surfaces it. A call carrying ONLY
 * options the running session already applies (language, pipelineId) is the
 * DESIGNED coordinated dual-hook path — that stays a silent `logger.info` +
 * return, not an error (tests (c)/(d) guard against over-throwing that path).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — same shape as the other useArcaAudio suites (task597/task609/
// task612-source-stream-validation): a spy-based AudioMixer double and a
// directly-swappable store.
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
import { AgenticError } from '../../types';

// ---------------------------------------------------------------------------
// Fakes — a MediaStream double with a single live audio track (liveness is
// not what this guard checks; Lane A owns that seam). Only used for test (d),
// which drives a normal first-time start to completion.
// ---------------------------------------------------------------------------
function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, readyState: 'live', stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  return { label, getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

/** Minimal spy-based logger double: `getLogger()` returns `store.logger?.child(...)`. */
function makeLoggerDouble() {
  const warn = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const childLogger = { warn, info, debug, error: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
  const logger = { child: vi.fn(() => childLogger) };
  return { logger, childLogger, warn, info, debug };
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

describe('useArcaAudio — CALL-TIME idempotence guard: dropped capture options surface as an error', () => {
  it('(a) rejects with CAPTURE_OPTIONS_DROPPED naming "sourceStreams" when capture is already active; warn is still logged', async () => {
    const pluginManager = createMockPluginManager({ initialized: true });
    const { logger, warn } = makeLoggerDouble();
    setupStore({ pluginManager, logger });
    const { result } = renderHook(() => useArcaAudio());

    const stream = makeStream('ext-mic');
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.start({ sourceStreams: [stream as unknown as MediaStream] });
        expect.unreachable('start() should have rejected');
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(AgenticError);
    expect((caught as InstanceType<typeof AgenticError>).code).toBe('CAPTURE_OPTIONS_DROPPED');
    expect((caught as Error).message).toContain('sourceStreams');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('(b) rejects naming BOTH "deviceId" and "dynamicSources" when both are dropped', async () => {
    const pluginManager = createMockPluginManager({ initialized: true });
    const { logger, warn } = makeLoggerDouble();
    setupStore({ pluginManager, logger });
    const { result } = renderHook(() => useArcaAudio());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
        expect.unreachable('start() should have rejected');
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(AgenticError);
    expect((caught as InstanceType<typeof AgenticError>).code).toBe('CAPTURE_OPTIONS_DROPPED');
    expect((caught as Error).message).toContain('deviceId');
    expect((caught as Error).message).toContain('dynamicSources');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('(c) resolves silently when capture is already active but the call carries ONLY language/pipelineId (coordinated dual-hook path); warn is NOT called', async () => {
    const pluginManager = createMockPluginManager({ initialized: true });
    const { logger, warn, info } = makeLoggerDouble();
    setupStore({ pluginManager, logger });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await expect(result.current.start({ language: 'en', pipelineId: 'pipe-1' })).resolves.toBeUndefined();
    });

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    // The already-active session was never touched: no second initialize.
    expect(pluginManager.initialize).not.toHaveBeenCalled();
  });

  it('(d) a normal FIRST start (pluginManager.initialized === false) carrying sourceStreams proceeds unaffected — the guard does not over-throw', async () => {
    const liveStream = makeStream('mic-ext');
    const pluginManager = createMockPluginManager(); // initialized: false (default)
    setupStore({ pluginManager });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: [liveStream as unknown as MediaStream] });
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(pluginManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'mic-ext' }),
      expect.objectContaining({ sampleRate: 48000 }),
    );
    expect(mockStoreData.setIsCapturing).toHaveBeenCalledWith(true);
  });
});
