/**
 * useArcaAudio — capture-device LOSS and dropped-start warnings (TASK-609).
 *
 * Two silent failures, same observable symptom as the multi-mic bug that
 * motivated this ticket ("socket open, no audio, no error"):
 *
 *  1. A microphone unplugged mid-session ends its `MediaStreamTrack`. Nothing
 *     listened for that, so capture simply stopped producing samples while the
 *     UI still said "recording".
 *  2. The compat layer drives ONE graph through TWO hooks, and the second
 *     `start()` is ignored — including every source option it carried. That was
 *     logged at INFO with only the language and pipeline id, so an integrator
 *     whose device selection was being discarded had nothing to see.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AgenticError } from '../../types';

const roomMocks = vi.hoisted(() => {
  class MockAudioMixer {
    addSource = vi.fn();
    removeSource = vi.fn();
    setSourceGain = vi.fn();
    startLevelMonitoring = vi.fn(() => true);
    stopLevelMonitoring = vi.fn();
    getMixedTrack = () => ({ kind: 'audio', label: 'mixed-track' });
    dispose = vi.fn();
  }
  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  return { MockAudioMixer, getInstance: vi.fn(() => ({ acquire })) };
});

vi.mock('@arcaai/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/room')>();
  return { ...actual, AudioMixer: roomMocks.MockAudioMixer, AudioContextManager: { getInstance: roomMocks.getInstance } };
});

let mockStoreData: Record<string, any>;
vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStoreData) }));

import { useArcaAudio } from '../useArcaAudio';
import { useAgenticStore } from '../../store';

/** A track that records its `ended` listeners so the test can fire the event. */
function makeStream(label: string) {
  const listeners: Record<string, ((ev?: unknown) => void)[]> = {};
  const track = {
    kind: 'audio',
    label,
    enabled: true,
    readyState: 'live' as string,
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
    }),
    _fire: (type: string) => (listeners[type] ?? []).forEach((fn) => fn()),
    _listenerCount: (type: string) => (listeners[type] ?? []).length,
  };
  return { label, getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

const logger = {
  child: vi.fn(() => logger),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  startOperation: vi.fn(() => ({ end: vi.fn(), error: vi.fn() })),
};

function setupStore() {
  mockStoreData = {
    pluginManager: {
      initialized: false,
      setRuntimeOptions: vi.fn(),
      clearRuntimeOptions: vi.fn(),
      setCallbacks: vi.fn(),
      initialize: vi.fn(async () => {
        mockStoreData.pluginManager.initialized = true;
      }),
      destroy: vi.fn(async () => {
        mockStoreData.pluginManager.initialized = false;
      }),
      getStates: vi.fn(() => ({ noiseFilter: {}, vad: {}, stt: {} })),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      getTranscriptionPipeline: vi.fn(() => null),
      getKnowledgePipeline: vi.fn(() => null),
    },
    consultation: { id: 'cons-1' },
    apiClient: null,
    logger,
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
    setAudioSourceIds: vi.fn(),
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

describe('useArcaAudio — device loss (TASK-609)', () => {
  it('surfaces an error when a capture device disappears mid-session', async () => {
    const stream = makeStream('USB Mic Array');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(stream);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });

    act(() => stream._track._fire('ended'));

    expect(mockStoreData.setAudioError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/USB Mic Array/) }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/capture source ended/i), expect.anything());
  });

  it('detaches the ended listeners on stop so a released track cannot fire later', async () => {
    const stream = makeStream('mic-A');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(stream);

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });
    expect(stream._track._listenerCount('ended')).toBe(1);

    await act(async () => {
      await result.current.stop();
    });
    expect(stream._track._listenerCount('ended')).toBe(0);
  });
});

describe('useArcaAudio — ignored start carrying source options (TASK-609)', () => {
  it('WARNS and REJECTS with CAPTURE_OPTIONS_DROPPED when a second start would have changed the sources', async () => {
    // Contract updated by TASK-612 (OD-2a): the warn stays for log triage, but a
    // dropped capture-shaped option set is now ALSO a rejected promise — the
    // pre-612 "warn and resolve" behavior was root cause RC-2 (default mic
    // streams while the UI shows the external selection, no surfaced error).
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ pipelineId: 'p1' });
    });

    let caught: unknown;
    await act(async () => {
      caught = await result.current
        .start({ deviceId: 'external-array', audioProcessing: { autoGainControl: false } })
        .catch((err: unknown) => err);
    });
    expect(caught).toBeInstanceOf(AgenticError);
    expect((caught as InstanceType<typeof AgenticError>).code).toBe('CAPTURE_OPTIONS_DROPPED');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/ignored/i),
      expect.objectContaining({ attributes: expect.objectContaining({ droppedOptions: ['deviceId', 'audioProcessing'] }) }),
    );
  });

  it('stays at INFO when the ignored start carried nothing that would have changed capture', async () => {
    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });

    logger.warn.mockClear();
    await act(async () => {
      await result.current.start({ language: 'en' });
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/ignored/i), expect.anything());
  });
});
