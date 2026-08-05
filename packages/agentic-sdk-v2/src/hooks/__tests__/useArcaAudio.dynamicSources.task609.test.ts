/**
 * useArcaAudio — RUNTIME capture-source management (TASK-609).
 *
 * An end user with several microphones must be able to add or drop one MID
 * CONSULTATION. Before 609 the only way was stop() + start(), which tears down
 * the WebSocket session and the transcript continuity with it — a UX cost with
 * no technical need behind it: `AudioMixer` has supported `addSource` /
 * `removeSource` / `setSourceGain` at runtime all along; `useArcaAudio` simply
 * built the mixer inside `start()` and never exposed it.
 *
 * The one real constraint is the graph: the pipeline is initialized with ONE
 * track, so sources can only be swapped underneath it when that track is the
 * mixer's output. A single-source session has no mixer (the device track is fed
 * straight through — the pre-597 behaviour, deliberately preserved), so runtime
 * changes there require opting in at start with `dynamicSources: true`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const roomMocks = vi.hoisted(() => {
  const addSource = vi.fn();
  const removeSource = vi.fn();
  const setSourceGain = vi.fn();
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
    setSourceGain = setSourceGain;
    startLevelMonitoring = startLevelMonitoring;
    stopLevelMonitoring = stopLevelMonitoring;
    getMixedTrack = () => ({ kind: 'audio', label: 'mixed-track' });
    dispose = dispose;
  }

  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  return { MockAudioMixer, mixerCtor, addSource, removeSource, setSourceGain, startLevelMonitoring, stopLevelMonitoring, dispose, getInstance: vi.fn(() => ({ acquire })) };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return { ...actual, AudioMixer: roomMocks.MockAudioMixer, AudioContextManager: { getInstance: roomMocks.getInstance } };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStoreData) }));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

function makeStream(label: string) {
  const track = { kind: 'audio', label, enabled: true, readyState: 'live' as const, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  return { label, getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

function setupStore() {
  mockStoreData = {
    pluginManager: {
      initialized: false,
      setRuntimeOptions: vi.fn(),
      clearRuntimeOptions: vi.fn(),
      setCallbacks: vi.fn(),
      initialize: vi.fn(async function (this: any) {
        mockStoreData.pluginManager.initialized = true;
      }),
      destroy: vi.fn(async function () {
        mockStoreData.pluginManager.initialized = false;
      }),
      getStates: vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: true },
        vad: { isActive: false, isSupported: true },
        stt: { isActive: true, isSupported: true, isProcessing: false },
      })),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      getTranscriptionPipeline: vi.fn(() => null),
      getKnowledgePipeline: vi.fn(() => null),
    },
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
    audioSourceIds: [],
    audioSourceLevels: [],
    audioPlugins: { noiseFilter: {}, vad: {}, stt: {} },
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
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupStore();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) } });
});

afterEach(() => vi.unstubAllGlobals());

describe('useArcaAudio — runtime source management (TASK-609)', () => {
  it('builds the mixer for a SINGLE source when dynamicSources is set, so the pipeline input is swappable', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });

    expect(roomMocks.mixerCtor).toHaveBeenCalledTimes(1);
    expect(roomMocks.addSource).toHaveBeenCalledTimes(1);
    // The pipeline reads the MIXER output, not the device track — that is what
    // makes a later addSource invisible to the transport.
    expect(mockStoreData.pluginManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'mixed-track' }),
      expect.anything(),
    );
    expect(mockStoreData.setAudioSourceIds).toHaveBeenCalledWith(['source-1']);
  });

  it('adds a microphone mid-session without touching the pipeline or the transport', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });

    const initializeCalls = mockStoreData.pluginManager.initialize.mock.calls.length;
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(makeStream('mic-B'));

    let id = '';
    await act(async () => {
      id = await result.current.addSource({ deviceId: 'mic-B', gain: 0.8 });
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-B' } } });
    // 4th arg since TASK-612 Lane B: a deviceId source is SDK-owned, so the
    // mixer releases its tracks on removal.
    expect(roomMocks.addSource).toHaveBeenLastCalledWith(id, expect.objectContaining({ label: 'mic-B' }), 0.8, { stopTracksOnRemove: true });
    expect(mockStoreData.setAudioSourceIds).toHaveBeenLastCalledWith(['source-1', id]);
    // The whole point: no re-initialize ⇒ the WebSocket session survives.
    expect(mockStoreData.pluginManager.initialize).toHaveBeenCalledTimes(initializeCalls);
  });

  it('inherits the session audioProcessing constraints for a runtime-added mic', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({
        deviceId: 'mic-A',
        dynamicSources: true,
        audioProcessing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    });

    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(makeStream('mic-B'));
    await act(async () => {
      await result.current.addSource({ deviceId: 'mic-B' });
    });

    // A mic added later must not silently arrive DSP'd when the session asked
    // for raw capture — the mix would be half-processed.
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: 'mic-B' }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  });

  it('accepts a caller-built stream as a runtime source', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ dynamicSources: true });
    });

    const injected = makeStream('file-stream');
    await act(async () => {
      await result.current.addSource({ stream: injected as unknown as MediaStream });
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1); // start only
    // 4th arg since TASK-612 Lane B: a caller-built stream is caller-owned —
    // the mixer must not stop its tracks on removal.
    expect(roomMocks.addSource).toHaveBeenLastCalledWith(expect.any(String), injected, 1.0, { stopTracksOnRemove: false });
  });

  it('removes a source and drops it from the published id list', async () => {
    const { result } = renderHook(() => useArcaAudio());
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(makeStream('mic-A')).mockResolvedValueOnce(makeStream('mic-B'));

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });

    await act(async () => {
      result.current.removeSource('source-2');
    });

    expect(roomMocks.removeSource).toHaveBeenCalledWith('source-2');
    expect(mockStoreData.setAudioSourceIds).toHaveBeenLastCalledWith(['source-1']);
  });

  it('refuses to remove the LAST source — that is stop(), and silence is not a capture state', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });

    expect(() => result.current.removeSource('source-1')).toThrow(/last capture source/i);
    expect(roomMocks.removeSource).not.toHaveBeenCalled();
  });

  it('sets a per-source gain at runtime', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });

    act(() => result.current.setSourceGain('source-1', 0.4));
    expect(roomMocks.setSourceGain).toHaveBeenCalledWith('source-1', 0.4);
  });

  it('rejects addSource on a single-source session that did not opt in, naming the fix', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' }); // no dynamicSources
    });

    await expect(result.current.addSource({ deviceId: 'mic-B' })).rejects.toThrow(/dynamicSources/);
  });

  it('rejects addSource when there is no capture session at all', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await expect(result.current.addSource({ deviceId: 'mic-B' })).rejects.toThrow(/no active capture session/i);
  });

  it('clears the published source ids on stop', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(mockStoreData.setAudioSourceIds).toHaveBeenLastCalledWith([]);
  });
});
