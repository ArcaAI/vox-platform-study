/**
 * useArcaAudio — empty-final hygiene (TASK-612 Lane F, finding I-1, OD-3a).
 *
 * The backend can emit `text: ''`/whitespace finals for silence windows.
 * Before this change every guard between the STT client and the store passed
 * them through unchanged: they became a `TranscriptSegment`, a context POST,
 * and (via compat) an `onTranscript("0 : ", true, …)` callback rendering
 * placeholders around nothing. OD-3a: suppress them — they carry no clinical
 * value. The interim clear (`store.setCurrentTranscript('')`) still runs,
 * since an empty final still means the interim window ended.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — same harness as task612-caller-owned-streams.test.ts: a spy-based
// AudioMixer double and a directly-swappable store double.
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
import type { TranscriptionResult } from '../../types';

// ---------------------------------------------------------------------------
// Fakes — minimal track/stream doubles, enough to satisfy Lane A's liveness
// validation and startAudio's default getUserMedia path.
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
  defaultGumStream = makeStream('gum-default');
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => defaultGumStream) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Starts a session against a store double carrying a live `consultation` +
 * `apiClient.post` spy, then returns the `PluginEventCallbacks` object
 * `useArcaAudio` handed to `pluginManager.setCallbacks` — the same seam the
 * real STT plugin drives `onTranscription` through.
 */
async function startAndGetCallbacks() {
  const apiClientPost = vi.fn(async () => ({ id: 'ctx-1' }));
  const store = setupStore({
    consultation: { id: 'cons-1' },
    apiClient: { post: apiClientPost },
  });
  const { result } = renderHook(() => useArcaAudio());

  await act(async () => {
    await result.current.start();
  });

  const setCallbacksMock = store.pluginManager.setCallbacks as ReturnType<typeof vi.fn>;
  const callbacks = setCallbacksMock.mock.calls[0]?.[0];
  return { store, callbacks, apiClientPost };
}

describe('useArcaAudio — empty-final hygiene (TASK-612 Lane F, OD-3a)', () => {
  it('(a) whitespace-only final: no segment added, no context POST', async () => {
    const { store, callbacks, apiClientPost } = await startAndGetCallbacks();

    act(() => {
      callbacks.onTranscription({ isFinal: true, text: '   ' } as TranscriptionResult);
    });

    expect(store.addTranscriptSegment).not.toHaveBeenCalled();
    expect(apiClientPost).not.toHaveBeenCalled();
  });

  it('(b) empty-string final: no segment added, no context POST', async () => {
    const { store, callbacks, apiClientPost } = await startAndGetCallbacks();

    act(() => {
      callbacks.onTranscription({ isFinal: true, text: '' } as TranscriptionResult);
    });

    expect(store.addTranscriptSegment).not.toHaveBeenCalled();
    expect(apiClientPost).not.toHaveBeenCalled();
  });

  it('(c) a real final still adds a segment AND fires the context POST (guard is narrow)', async () => {
    const { store, callbacks, apiClientPost } = await startAndGetCallbacks();

    act(() => {
      callbacks.onTranscription({ isFinal: true, text: 'real words' } as TranscriptionResult);
    });

    expect(store.addTranscriptSegment).toHaveBeenCalledTimes(1);
    expect(store.addTranscriptSegment).toHaveBeenCalledWith(expect.objectContaining({ text: 'real words', isFinal: true }));
    expect(apiClientPost).toHaveBeenCalledTimes(1);
  });

  it('(d) an interim result is unaffected by the final guard', async () => {
    const { store, callbacks } = await startAndGetCallbacks();

    act(() => {
      callbacks.onTranscription({ isFinal: false, text: 'partial' } as TranscriptionResult);
    });

    expect(store.setCurrentTranscript).toHaveBeenCalledWith('partial');
    expect(store.addTranscriptSegment).not.toHaveBeenCalled();
  });

  it('(e) a whitespace-only final still clears the interim transcript', async () => {
    const { store, callbacks } = await startAndGetCallbacks();

    act(() => {
      callbacks.onTranscription({ isFinal: true, text: '   ' } as TranscriptionResult);
    });

    expect(store.setCurrentTranscript).toHaveBeenCalledWith('');
  });
});
