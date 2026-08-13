/**
 * useArcaAudio — `removeSource(id)` must drop the removed stream from the
 * session's stream registry, not just from the mixer and `sourceIdsRef`
 *
 * `removeSource` called `mixer.removeSource(id)` (which stops that
 * source's tracks) and filtered the id out of `sourceIdsRef`, but never
 * touched `sourceStreamsRef` — the array `applyEnabledToAllSources` (mute/
 * unmute) and `stopAudio` teardown both walk (see its REF CONTRACT docblock,
 * ~line 111). The dead stream stayed in that array for the rest of the
 * session, so:
 *   - unmute() after a removal re-enabled tracks on an already-ended stream
 *     (harmless on an ended track today, but wrong, and the mute-count
 *     bookkeeping papered over a stream that should not be there at all);
 *   - a stream that no longer exists never leaves the registry, so nothing
 *     downstream can ever tell "removed" apart from "still owned".
 *
 * Assertion strategy: mute()/unmute() write `track.enabled` — that write log
 * is the only externally observable signal the harness has into
 * `sourceStreamsRef`'s contents, so this test asserts the removed source's
 * track receives NO further `enabled` writes after `removeSource`, while the
 * remaining sources keep muting/unmuting correctly.
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
  return { MockAudioMixer, mixerCtor, addSource, removeSource, dispose, getInstance: vi.fn(() => ({ acquire })) };
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
 * `enabled` is a counting accessor, not a plain field — the "no further
 * writes" assertion is only observable via the write log, exactly as in the
 * Mute suite.
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

describe('useArcaAudio — removeSource drops the stream from the session registry', () => {
  it('stops muting/unmuting a removed source while the remaining sources keep working', async () => {
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

    // source-2 mixes in mic-B (source-1 = mic-A, source-2 = mic-B, source-3 = mic-C).
    act(() => result.current.removeSource('source-2'));
    expect(roomMocks.removeSource).toHaveBeenCalledWith('source-2');

    act(() => result.current.mute());
    // mic-A and mic-C are still owned — they must mute normally.
    expect(micA._track._writes).toEqual([false]);
    expect(micC._track._writes).toEqual([false]);
    // mic-B was removed — the defect let it keep receiving writes forever.
    expect(micB._track._writes).toEqual([]);

    act(() => result.current.unmute());
    expect(micA._track._writes).toEqual([false, true]);
    expect(micC._track._writes).toEqual([false, true]);
    expect(micB._track._writes).toEqual([]);
  });

  it('does not touch a removed source even across multiple mute/unmute cycles', async () => {
    const micA = makeStream('mic-A');
    const micB = makeStream('mic-B');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(micA).mockResolvedValueOnce(micB);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });

    act(() => result.current.removeSource('source-1'));

    act(() => result.current.mute());
    act(() => result.current.unmute());
    act(() => result.current.mute());

    // mic-A (source-1, and also `store.activeStream`) was removed from
    // `sourceStreamsRef`; `activeStream` itself is untouched by removeSource,
    // so the union in `applyEnabledToAllSources` still covers it via
    // `store.activeStream` — assert on mic-B alone, the one whose ONLY path
    // into the mute walk is `sourceStreamsRef`.
    expect(micB._track._writes).toEqual([false, true, false]);
  });
});
