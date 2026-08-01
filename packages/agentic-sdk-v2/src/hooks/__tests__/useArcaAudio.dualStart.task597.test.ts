/**
 * useArcaAudio — coordinated dual-hook START (TASK-597 follow-up).
 *
 * The defect class: the compat layer drives ONE audio graph through TWO hooks
 * (`useAudioCapture.startRecording()` then `useArcaSpeechToText.startTranscription()`),
 * each guarded only by a RENDER-TIME `isCapturing` snapshot. A consumer that
 * starts both from one click handler therefore reaches `startAudio` twice —
 * and the second pass used to run in full:
 *
 *   • `pluginManager.setRuntimeOptions` was called AGAIN with the second
 *     caller's option set, wholesale-REPLACING the first call's options. The
 *     drain knobs (`drainTimeoutMs`/`quietWindowMs`) ride only the FIRST
 *     caller (the capture hook), so the replacement dropped exactly the
 *     settings a tail-final accuracy run depends on.
 *   • `getUserMedia` was called AGAIN, opening a second hot microphone stream
 *     that replaced `store.activeStream`.
 *
 * The fix: `startAudio` checks `pluginManager.initialized` — shared,
 * call-time state, unlike the hooks' stale closures — and joins (no-ops) when
 * a capture session already exists.
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
  const track = {
    kind: 'audio',
    label,
    enabled: true,
    readyState: 'live' as 'live' | 'ended',
    stop: vi.fn(() => {
      track.readyState = 'ended';
    }),
  };
  return { label, getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

/**
 * A pluginManager double with a REAL `initialized` lifecycle — the shared
 * state the guard under test reads. `initialize` flips it true; `destroy`
 * flips it false, exactly like the real manager.
 */
function createLifecyclePluginManager() {
  const manager = {
    _initialized: false,
    get initialized() {
      return this._initialized;
    },
    setRuntimeOptions: vi.fn(),
    clearRuntimeOptions: vi.fn(),
    setCallbacks: vi.fn(),
    initialize: vi.fn(async function (this: any) {
      manager._initialized = true;
    }),
    destroy: vi.fn(async () => {
      manager._initialized = false;
    }),
    getStates: vi.fn(() => ({
      noiseFilter: { isActive: false, isSupported: true },
      vad: { isActive: true, isSupported: true },
      stt: { isActive: true, isSupported: true, isProcessing: false },
    })),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    getTranscriptionPipeline: vi.fn(() => null),
    getKnowledgePipeline: vi.fn(() => null),
  };
  return manager;
}

function setupStore(overrides: Record<string, any> = {}) {
  mockStoreData = {
    pluginManager: null,
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

    setIsCapturing: vi.fn((v: boolean) => {
      mockStoreData.isCapturing = v;
    }),
    setIsMuted: vi.fn(),
    setAudioLevel: vi.fn(),
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

describe('useArcaAudio — second start() joins instead of clobbering (TASK-597)', () => {
  it('a second start() while capture is active is a no-op: runtime options (incl. drain knobs) survive', async () => {
    const pm = createLifecyclePluginManager();
    setupStore({ pluginManager: pm });

    const { result } = renderHook(() => useArcaAudio());

    // First start — the capture hook's call, carrying the drain knobs.
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1', drainTimeoutMs: 60_000, quietWindowMs: 30_000 });
    });
    expect(pm.setRuntimeOptions).toHaveBeenCalledTimes(1);
    expect(pm.setRuntimeOptions.mock.calls[0][0]).toMatchObject({ drainTimeoutMs: 60_000, quietWindowMs: 30_000 });

    // Second start — the STT hook's call, same handler, stale isCapturing
    // closure, and NO drain knobs. Must not replace the first call's options.
    await act(async () => {
      await result.current.start({ pipelineId: 'pipe-1', language: 'ml' });
    });

    expect(pm.setRuntimeOptions).toHaveBeenCalledTimes(1);
    expect(pm.initialize).toHaveBeenCalledTimes(1);
    // No second hot microphone either.
    expect((navigator.mediaDevices.getUserMedia as any).mock.calls.length).toBe(1);
  });

  it('start() after stop() runs a full new capture session', async () => {
    const pm = createLifecyclePluginManager();
    setupStore({ pluginManager: pm });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ quietWindowMs: 0 });
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(pm.destroy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.start({ quietWindowMs: 250 });
    });
    expect(pm.setRuntimeOptions).toHaveBeenCalledTimes(2);
    expect(pm.initialize).toHaveBeenCalledTimes(2);
  });
});
