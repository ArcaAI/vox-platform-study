/**
 * useArcaAudio — mute() must silence EVERY capture source.
 *
 * Mute acted on `store.activeStream` alone, i.e. the FIRST resolved source.
 * Since a session can mix N microphones into one uplink, and since
 * A mic can join mid-consultation — so in any multi-mic room clicking
 * Mute silenced microphone 1 and left every other microphone live on the
 * socket. The clinician believes the room is muted while it is still being
 * transcribed: a privacy failure, not a UX one.
 *
 * The authoritative source list is `sourceStreamsRef` (see its REF CONTRACT).
 * `activeStream` is normally its first entry, so the two are unioned and
 * DE-DUPLICATED by track identity — a track toggled twice is a latent bug the
 * moment anything other than a boolean assignment hangs off `enabled`.
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
  return { MockAudioMixer, mixerCtor, addSource, dispose, getInstance: vi.fn(() => ({ acquire })) };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return { ...actual, AudioMixer: roomMocks.MockAudioMixer, AudioContextManager: { getInstance: roomMocks.getInstance } };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStoreData) }));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

/**
 * `enabled` is a counting accessor, not a plain field: the dedupe requirement
 * is only observable as "how many times was this track written", so a test that
 * merely read the final boolean would pass with a double-toggle in place.
 */
function makeStream(label: string) {
  let enabled = true;
  const writes: boolean[] = [];
  const track = {
    kind: 'audio',
    label,
    readyState: 'live' as const,
    get enabled() {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
      writes.push(value);
    },
    _writes: writes,
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { label, getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

function setupStore() {
  mockStoreData = {
    pluginManager: {
      initialized: false,
      setRuntimeOptions: vi.fn(),
      clearRuntimeOptions: vi.fn(),
      setCallbacks: vi.fn(),
      initialize: vi.fn(async function () {
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
    setIsMuted: vi.fn((v: boolean) => {
      mockStoreData.isMuted = v;
    }),
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

describe('useArcaAudio — mute covers every capture source', () => {
  it('mutes and unmutes ALL three microphones of a mixed session, not just the first', async () => {
    const micA = makeStream('mic-A');
    const micB = makeStream('mic-B');
    const micC = makeStream('mic-C');
    (navigator.mediaDevices.getUserMedia as any)
      .mockResolvedValueOnce(micA)
      .mockResolvedValueOnce(micB)
      .mockResolvedValueOnce(micC);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B', additionalDeviceIds: ['mic-C'] });
    });

    act(() => result.current.mute());
    expect(mockStoreData.setIsMuted).toHaveBeenCalledWith(true);
    // The defect: B and C stayed live and kept streaming to the backend.
    expect([micA._track.enabled, micB._track.enabled, micC._track.enabled]).toEqual([false, false, false]);

    act(() => result.current.unmute());
    expect(mockStoreData.setIsMuted).toHaveBeenLastCalledWith(false);
    expect([micA._track.enabled, micB._track.enabled, micC._track.enabled]).toEqual([true, true, true]);
  });

  it('writes each track exactly once per mute — activeStream and the source list overlap', async () => {
    const micA = makeStream('mic-A');
    const micB = makeStream('mic-B');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(micA).mockResolvedValueOnce(micB);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });

    act(() => result.current.mute());

    // mic-A is BOTH store.activeStream and sourceStreams[0]; unioning the two
    // without de-duplicating would toggle it twice.
    expect(micA._track._writes).toEqual([false]);
    expect(micB._track._writes).toEqual([false]);
  });

  it('leaves the single-source session behaving exactly as before', async () => {
    const mic = makeStream('only-mic');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(mic);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'only-mic' });
    });

    act(() => result.current.mute());
    expect(mic._track._writes).toEqual([false]);

    act(() => result.current.unmute());
    expect(mic._track._writes).toEqual([false, true]);
  });

  it('delivers a runtime-added source MUTED when the session is muted', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });

    act(() => result.current.mute());

    const late = makeStream('mic-late');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(late);
    await act(async () => {
      await result.current.addSource({ deviceId: 'mic-late' });
    });

    // Otherwise plugging a mic in silently un-mutes part of the room, and the
    // later unmute() lands on an already-live track.
    expect(late._track.enabled).toBe(false);
  });

  it('delivers a runtime-added source LIVE when the session is not muted', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });

    const late = makeStream('mic-late');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(late);
    await act(async () => {
      await result.current.addSource({ deviceId: 'mic-late' });
    });

    expect(late._track.enabled).toBe(true);
    expect(late._track._writes).toEqual([]);
  });
});
