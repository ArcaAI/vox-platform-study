/**
 * useArcaAudio — audio SOURCE selection (TASK-597 lane A).
 *
 * The developer console needs four capture modes, all through the SAME
 * mixer → noise-filter → VAD → STT graph:
 *   1. one mic                       → no mixer, track used directly
 *   2. N mics mixed to one uplink    → AudioMixer with N sources
 *   3. one audio file as a mic       → `sourceStreams` bypasses getUserMedia
 *   4. N audio files mixed           → `sourceStreams` + mixer
 *
 * Plus the invariant that motivated the change: after stop(), EVERY source
 * track is ended. A leaked track keeps the browser recording indicator lit.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks. The AudioMixer double records (id, stream, gain) per source and, like
// the real one, stops each source's tracks on dispose().
// ---------------------------------------------------------------------------
const roomMocks = vi.hoisted(() => {
  const mixerCtor = vi.fn();
  const addSource = vi.fn();
  const getMixedTrack = vi.fn(() => ({ kind: 'audio', label: 'mixed-track' }));
  const dispose = vi.fn();

  class MockAudioMixer {
    private readonly held: { stream: { getTracks(): { stop(): void }[] } }[] = [];
    constructor(ctx: unknown) {
      mixerCtor(ctx);
    }
    addSource = (id: string, stream: any, gain?: number) => {
      this.held.push({ stream });
      addSource(id, stream, gain);
    };
    getMixedTrack = getMixedTrack;
    dispose = () => {
      // Mirrors the real AudioMixer: removeSource() stops the source's tracks.
      this.held.forEach((s) => s.stream.getTracks().forEach((t: { stop(): void }) => t.stop()));
      this.held.length = 0;
      dispose();
    };
  }

  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  const getInstance = vi.fn(() => ({ acquire }));

  return { mixerCtor, addSource, getMixedTrack, dispose, MockAudioMixer, acquire, getInstance };
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
// Helpers — a stream whose tracks carry a real `readyState` so teardown can be
// asserted the way a browser would report it.
// ---------------------------------------------------------------------------
interface FakeTrack {
  kind: string;
  label: string;
  enabled: boolean;
  readyState: 'live' | 'ended';
  stop: () => void;
}

function makeStream(label: string) {
  const track: FakeTrack = {
    kind: 'audio',
    label,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(function (this: FakeTrack) {
      track.readyState = 'ended';
    }),
  };
  return {
    label,
    getAudioTracks: () => [track],
    getTracks: () => [track],
    _track: track,
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
    mediaDevices: {
      getUserMedia: vi.fn(async () => makeStream('default')),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// N-source mixing
// ===========================================================================
describe('useArcaAudio — N-source mic mixing (additionalDeviceIds)', () => {
  it('opens every selected mic in resolved order and mixes all of them into one track', async () => {
    const streams = ['mic-A', 'mic-B', 'mic-C', 'mic-D'].map(makeStream);
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    streams.forEach((s) => getUserMedia.mockResolvedValueOnce(s));

    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({
        deviceId: 'mic-A',
        secondaryDeviceId: 'mic-B',
        additionalDeviceIds: ['mic-C', 'mic-D'],
      });
    });

    // Resolved order is [deviceId, secondaryDeviceId, ...additionalDeviceIds].
    expect(getUserMedia).toHaveBeenCalledTimes(4);
    ['mic-A', 'mic-B', 'mic-C', 'mic-D'].forEach((id, index) => {
      expect(getUserMedia.mock.calls[index][0]).toEqual({ audio: { deviceId: { exact: id } } });
    });

    // All four went into ONE mixer — no ceiling of two.
    expect(roomMocks.mixerCtor).toHaveBeenCalledTimes(1);
    expect(roomMocks.addSource).toHaveBeenCalledTimes(4);
    // ...and the pipeline sees the single mixed track, not four inputs.
    expect(pluginManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'mixed-track' }),
      expect.objectContaining({ sampleRate: 48000 }),
    );
  });

  it('applies per-source gains index-aligned with the resolved source list', async () => {
    ['mic-A', 'mic-B', 'mic-C'].map(makeStream).forEach((s) => {
      (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(s);
    });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({
        deviceId: 'mic-A',
        secondaryDeviceId: 'mic-B',
        additionalDeviceIds: ['mic-C'],
        // Third gain omitted on purpose — it must default to unity.
        sourceGains: [0.5, 1.5],
      });
    });

    expect(roomMocks.addSource.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['source-1', 0.5],
      ['source-2', 1.5],
      ['source-3', 1.0],
    ]);
  });

  it('de-duplicates repeated device ids so the same mic is never opened twice', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-A', additionalDeviceIds: ['mic-A', ''] });
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    // One resolved source ⇒ no mixer at all.
    expect(roomMocks.mixerCtor).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Injected (file-backed) streams
// ===========================================================================
describe('useArcaAudio — injected source streams (sourceStreams)', () => {
  it('a single injected stream bypasses getUserMedia and feeds its track directly', async () => {
    const fileStream = makeStream('file-1');
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: [fileStream as unknown as MediaStream] });
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(roomMocks.mixerCtor).not.toHaveBeenCalled();
    expect(pluginManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'file-1' }),
      expect.objectContaining({ sampleRate: 48000 }),
    );
  });

  it('several injected streams are mixed into one uplink track, still without getUserMedia', async () => {
    const files = [makeStream('file-1'), makeStream('file-2'), makeStream('file-3')];
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: files as unknown as MediaStream[] });
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(roomMocks.addSource).toHaveBeenCalledTimes(3);
    expect(pluginManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'mixed-track' }),
      expect.anything(),
    );
  });

  it('ignores the deviceId fields when streams are injected (streams win)', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({
        deviceId: 'mic-A',
        secondaryDeviceId: 'mic-B',
        sourceStreams: [makeStream('file-1') as unknown as MediaStream],
      });
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Teardown — the invariant the ref-shape change exists for
// ===========================================================================
describe('useArcaAudio — source teardown', () => {
  it('ends EVERY mic track after stop() (N > 2 leaked before TASK-597)', async () => {
    const streams = ['mic-A', 'mic-B', 'mic-C'].map(makeStream);
    streams.forEach((s) => (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(s));

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B', additionalDeviceIds: ['mic-C'] });
    });
    expect(streams.map((s) => s._track.readyState)).toEqual(['live', 'live', 'live']);

    await act(async () => {
      await result.current.stop();
    });

    expect(streams.map((s) => s._track.readyState)).toEqual(['ended', 'ended', 'ended']);
  });

  it('ends every injected (file-backed) source track after stop()', async () => {
    const files = [makeStream('file-1'), makeStream('file-2')];

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: files as unknown as MediaStream[] });
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(files.map((s) => s._track.readyState)).toEqual(['ended', 'ended']);
  });

  it('ends already-acquired tracks when a later getUserMedia rejects', async () => {
    const first = makeStream('mic-A');
    const getUserMedia = navigator.mediaDevices.getUserMedia as any;
    getUserMedia.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('NotFoundError'));

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await expect(result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-gone' })).rejects.toThrow(
        'NotFoundError',
      );
    });

    expect(first._track.readyState).toBe('ended');
  });
});

// ===========================================================================
// Regression — the pre-597 shapes are byte-identical
// ===========================================================================
describe('useArcaAudio — source regression', () => {
  it('start() with no options still requests the default mic and builds no mixer', async () => {
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start();
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(roomMocks.mixerCtor).not.toHaveBeenCalled();
  });

  it('start({ deviceId, secondaryDeviceId }) still opens exactly two mics and mixes them', async () => {
    ['mic-A', 'mic-B'].map(makeStream).forEach((s) => {
      (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(s);
    });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B' });
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(roomMocks.addSource).toHaveBeenCalledTimes(2);
  });
});
