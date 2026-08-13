/**
 * useArcaAudio — injected-stream LIVENESS validation.
 *
 * `AudioStartOptions.sourceStreams` lets a caller hand the SDK an already-built
 * `MediaStream` (external mic, file playback, a reused stream from a prior
 * session) instead of calling `getUserMedia` itself. Before this change the
 * list was filtered on truthiness ONLY, and the first source's
 * `stream.getAudioTracks()[0]` was read unguarded — so a stream with no audio
 * track, or one whose only track had already ended (`readyState: 'ended'`,
 * e.g. a reused stream from a stopped session), was accepted and produced a
 * STRUCTURALLY VALID capture session whose uplink carried nothing: no
 * transcripts, no error, no signal — exactly the "empty data on the socket"
 * symptom this ticket exists to eliminate.
 *
 * The fix validates every injected stream BEFORE any teardown-sensitive state
 * is armed (source-loss watchers, the level meter, `sourceStreamsRef`
 * registration, `getUserMedia`) and throws a named `AgenticError`
 * (`SOURCE_STREAM_NOT_LIVE`) naming the offending index/indices instead. The
 * same contract applies to the runtime `addSource({ stream })` seam
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — same shape as the other useArcaAudio suites (task597/task609):
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
// Fakes — a MediaStream double whose track COUNT and `readyState` are fully
// controllable, since that pair is exactly what the validation reads.
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

/**
 * `trackCount: 0` simulates a stream with no audio track at all (e.g. a
 * video-only stream, or one whose track was already removed). Omitting it
 * yields a single track at the given `readyState` — 'ended' simulates a
 * stream reused after its previous session stopped it (RC-3's motivating
 * case), 'live' (the default) is a normal usable stream.
 */
function makeStream(label: string, opts: { readyState?: 'live' | 'ended'; trackCount?: 0 | 1 } = {}) {
  const tracks: FakeTrack[] = (opts.trackCount ?? 1) === 0 ? [] : [makeTrack(label, opts.readyState ?? 'live')];
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

// ===========================================================================
// start() — sourceStreams liveness validation
// ===========================================================================
describe('useArcaAudio — injected sourceStreams liveness validation (start)', () => {
  it('(a) rejects a single injected stream whose only audio track has ended, naming index 0', async () => {
    const deadStream = makeStream('dead', { readyState: 'ended' });
    const { result } = renderHook(() => useArcaAudio());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.start({ sourceStreams: [deadStream as unknown as MediaStream] });
        expect.unreachable('start() should have rejected');
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(AgenticError);
    expect((caught as InstanceType<typeof AgenticError>).code).toBe('SOURCE_STREAM_NOT_LIVE');
    expect((caught as Error).message).toContain('sourceStreams[0]');
    expect((caught as Error).message).toContain('no live audio track');
  });

  it('(b) rejects an injected stream with zero audio tracks, message says "no audio track"', async () => {
    const trackless = makeStream('trackless', { trackCount: 0 });
    const { result } = renderHook(() => useArcaAudio());

    await expect(result.current.start({ sourceStreams: [trackless as unknown as MediaStream] })).rejects.toMatchObject({
      code: 'SOURCE_STREAM_NOT_LIVE',
      message: expect.stringContaining('no audio track'),
    });
  });

  it('(c) sourceStreams [live, ended] rejects naming index 1 only', async () => {
    const live = makeStream('live-mic');
    const dead = makeStream('dead-mic', { readyState: 'ended' });
    const { result } = renderHook(() => useArcaAudio());

    await expect(
      result.current.start({ sourceStreams: [live as unknown as MediaStream, dead as unknown as MediaStream] }),
    ).rejects.toMatchObject({
      code: 'SOURCE_STREAM_NOT_LIVE',
      message: expect.stringContaining('sourceStreams[1]'),
    });

    // The live stream at index 0 must not be named as a violator.
    try {
      await result.current.start({ sourceStreams: [live as unknown as MediaStream, dead as unknown as MediaStream] });
    } catch (error) {
      expect((error as Error).message).not.toContain('sourceStreams[0]');
    }
  });

  it('(d) an all-live injected stream proceeds exactly as before — capture reaches pluginManager.initialize', async () => {
    const liveStream = makeStream('file-1');
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ sourceStreams: [liveStream as unknown as MediaStream] });
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(pluginManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'file-1' }),
      expect.objectContaining({ sampleRate: 48000 }),
    );
    expect(mockStoreData.setIsCapturing).toHaveBeenCalledWith(true);
  });

  it('(f) a validation rejection stops none of the caller-owned tracks and arms no timer', async () => {
    const deadStream = makeStream('dead', { readyState: 'ended' });
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });
    const { result } = renderHook(() => useArcaAudio());

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await act(async () => {
      await expect(result.current.start({ sourceStreams: [deadStream as unknown as MediaStream] })).rejects.toMatchObject({
        code: 'SOURCE_STREAM_NOT_LIVE',
      });
    });

    // The caller's own track was never touched by the failure path — the
    // validation runs BEFORE `sourceStreamsRef` registers the stream, so the
    // existing failed-start teardown loop (which stops every registered
    // stream's tracks) never sees it.
    expect(deadStream._tracks[0].stop).not.toHaveBeenCalled();
    // Nothing downstream of registration ran either: no getUserMedia, no
    // pipeline initialize, no level-meter/uplink-poll timer armed.
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(pluginManager.initialize).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('(g) defensively rejects a trackless FIRST source even on the device (non-injected) path', async () => {
    // Guards the unguarded `stream.getAudioTracks()[0]` read (RC-3): the
    // aggregate sourceStreams check above only ever sees INJECTED streams, so
    // this is the backstop for a getUserMedia-acquired stream that somehow
    // carries no audio track. Without the guard this used to be a SILENT
    // success (`pluginManager.initialize` called with an `undefined` track,
    // `isCapturing` flips true, no error) — the exact "structurally valid,
    // zero uplink" failure mode this ticket exists to close.
    const tracklessDeviceStream = makeStream('mic-A', { trackCount: 0 });
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(tracklessDeviceStream);
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });

    const { result } = renderHook(() => useArcaAudio());

    await expect(result.current.start({ deviceId: 'mic-A' })).rejects.toMatchObject({
      code: 'SOURCE_STREAM_NOT_LIVE',
      message: expect.stringContaining('no audio track'),
    });

    expect(pluginManager.initialize).not.toHaveBeenCalled();
    expect(mockStoreData.setIsCapturing).not.toHaveBeenCalledWith(true);
  });
});

// ===========================================================================
// addSource({ stream }) — same liveness contract at runtime (addSource seam)
// ===========================================================================
describe('useArcaAudio — injected stream liveness validation (addSource)', () => {
  it('(e) rejects a dead injected stream and leaves the running session usable for a subsequent valid add', async () => {
    const pluginManager = createMockPluginManager();
    setupStore({ pluginManager });
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });
    expect(mockStoreData.audioSourceIds).toEqual(['source-1']);

    const deadStream = makeStream('dead-file', { readyState: 'ended' });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.addSource({ stream: deadStream as unknown as MediaStream });
        expect.unreachable('addSource() should have rejected');
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(AgenticError);
    expect((caught as InstanceType<typeof AgenticError>).code).toBe('SOURCE_STREAM_NOT_LIVE');

    // No registry/mixer mutation from the failed add: the mixer never saw the
    // dead stream, the published id list is unchanged, and the id counter
    // was never consumed for it.
    expect(roomMocks.addSource).not.toHaveBeenCalledWith(expect.any(String), deadStream, expect.anything());
    expect(mockStoreData.audioSourceIds).toEqual(['source-1']);

    // The running session is still fully usable — a subsequent VALID add
    // succeeds and gets the id the failed attempt did NOT consume.
    const liveStream = makeStream('live-file');
    let id = '';
    await act(async () => {
      id = await result.current.addSource({ stream: liveStream as unknown as MediaStream });
    });
    expect(id).toBe('source-2');
    // 4th arg since: a caller-built stream registers
    // caller-owned, so the mixer must not stop its tracks on removal.
    expect(roomMocks.addSource).toHaveBeenCalledWith('source-2', liveStream, 1.0, { stopTracksOnRemove: false });
  });

  it('rejects a trackless injected stream on addSource, message says "no audio track"', async () => {
    setupStore();
    const { result } = renderHook(() => useArcaAudio());

    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', dynamicSources: true });
    });

    const trackless = makeStream('trackless-file', { trackCount: 0 });
    await expect(result.current.addSource({ stream: trackless as unknown as MediaStream })).rejects.toMatchObject({
      code: 'SOURCE_STREAM_NOT_LIVE',
      message: expect.stringContaining('no audio track'),
    });
  });
});
