/**
 * useArcaAudio — stop ORDERING.
 *
 * The defect: `stopAudio` awaited `pluginManager.destroy()` — which blocks on
 * the streaming STT drain — and only THEN stopped the media tracks and cleared
 * `isCapturing`. Clicking Stop therefore left the browser's recording indicator
 * lit and the UI in "recording" for the entire drain window.
 *
 * The fix must satisfy BOTH halves at once, and this file exists to keep them
 * from drifting apart:
 *
 *   1. Everything the user can see — tracks ended, `isCapturing` false, level
 *      zeroed, meters torn down — happens BEFORE the awaited destroy resolves.
 *   2. A tail final that arrives DURING the drain still reaches the store.
 *      Losing it would defeat the only reason the drain exists; a "fast" stop
 *      that drops the last caption is not a fix.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const roomMocks = vi.hoisted(() => {
  const acquire = vi.fn(async () => ({ sampleRate: 48000 }));
  const getInstance = vi.fn(() => ({ acquire }));
  class MockAudioMixer {
    private readonly held: { stream: { getTracks(): { stop(): void }[] } }[] = [];
    addSource = (_id: string, stream: any) => {
      this.held.push({ stream });
    };
    getMixedTrack = () => ({ kind: 'audio', label: 'mixed-track' });
    dispose = () => {
      this.held.forEach((s) => s.stream.getTracks().forEach((t: { stop(): void }) => t.stop()));
      this.held.length = 0;
    };
  }
  return { acquire, getInstance, MockAudioMixer };
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
// Harness. Every observable teardown step appends to ONE ordered log, so the
// assertions are about SEQUENCE rather than about "did it happen at all" —
// which is the whole point of this defect.
// ---------------------------------------------------------------------------
let events: string[] = [];

function makeStream(label: string) {
  const track = {
    kind: 'audio',
    label,
    enabled: true,
    readyState: 'live' as 'live' | 'ended',
    stop: vi.fn(() => {
      track.readyState = 'ended';
      events.push(`track-stop:${label}`);
    }),
  };
  return { label, getAudioTracks: () => [track], getTracks: () => [track], _track: track };
}

/** A pluginManager whose `destroy()` hangs until the test releases it. */
function createDeferredPluginManager() {
  let release!: () => void;
  const destroyed = new Promise<void>((resolve) => {
    release = () => {
      events.push('destroy-resolved');
      resolve();
    };
  });
  const setCallbacks = vi.fn();
  return {
    manager: {
      setRuntimeOptions: vi.fn(),
      clearRuntimeOptions: vi.fn(),
      setCallbacks,
      initialize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(() => {
        events.push('destroy-called');
        return destroyed;
      }),
      getStates: vi.fn(() => ({
        noiseFilter: { isActive: false, isSupported: true },
        vad: { isActive: true, isSupported: true },
        stt: { isActive: true, isSupported: true, isProcessing: false },
      })),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      getTranscriptionPipeline: vi.fn(() => null),
      getKnowledgePipeline: vi.fn(() => null),
    },
    release,
    /** The `onTranscription` the hook wired at start — the tail-final entrypoint. */
    getOnTranscription: () => setCallbacks.mock.calls[0][0].onTranscription as (r: any) => void,
  };
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
      events.push(`isCapturing:${v}`);
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
    addTranscriptSegment: vi.fn((seg: { text: string }) => {
      events.push(`segment:${seg.text}`);
    }),
    addContextItem: vi.fn(),
    addEntities: vi.fn(),
    resetAudioDropped: vi.fn(() => events.push('resetAudioDropped')),
    markAudioLost: vi.fn(),
    incrementDroppedFrames: vi.fn(),
    ...overrides,
  };
  (useAgenticStore as any).mockReturnValue(mockStoreData);
  return mockStoreData;
}

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  setupStore();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => makeStream('default')) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useArcaAudio — stop() releases the mic before the drain (D2)', () => {
  it('ends every track and clears isCapturing BEFORE the awaited destroy resolves', async () => {
    const mic = makeStream('mic-A');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(mic);
    const pm = createDeferredPluginManager();
    setupStore({ pluginManager: pm.manager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });
    expect(mic._track.readyState).toBe('live');

    // Click Stop. Do NOT await — the whole point is what is already true here.
    let stopPromise!: Promise<void>;
    act(() => {
      stopPromise = result.current.stop();
    });

    // The user-visible half is done, synchronously, with destroy still pending.
    expect(mic._track.readyState).toBe('ended');
    expect(mockStoreData.setIsCapturing).toHaveBeenCalledWith(false);
    expect(mockStoreData.setAudioLevel).toHaveBeenCalledWith(0);
    expect(mockStoreData.setCurrentTranscript).toHaveBeenCalledWith('');
    expect(pm.manager.destroy).toHaveBeenCalledTimes(1);

    // ...and stop() genuinely has NOT resolved (a resolved promise here would
    // mean the drain was skipped, not that it was reordered).
    let settled = false;
    void stopPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await act(async () => {
      pm.release();
      await stopPromise;
    });
    expect(settled).toBe(true);

    // Sequence, not just presence.
    expect(events.indexOf('track-stop:mic-A')).toBeLessThan(events.indexOf('destroy-resolved'));
    expect(events.indexOf('isCapturing:false')).toBeLessThan(events.indexOf('destroy-called'));
  });

  it('mixed multi-source capture releases EVERY source before the drain resolves', async () => {
    const streams = ['mic-A', 'mic-B', 'mic-C'].map(makeStream);
    streams.forEach((s) => (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(s));
    const pm = createDeferredPluginManager();
    setupStore({ pluginManager: pm.manager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A', secondaryDeviceId: 'mic-B', additionalDeviceIds: ['mic-C'] });
    });

    let stopPromise!: Promise<void>;
    act(() => {
      stopPromise = result.current.stop();
    });

    expect(streams.map((s) => s._track.readyState)).toEqual(['ended', 'ended', 'ended']);
    expect(events).not.toContain('destroy-resolved');

    await act(async () => {
      pm.release();
      await stopPromise;
    });
  });

  // -------------------------------------------------------------------------
  // The load-bearing half. A fast stop that drops the tail caption is not a fix.
  // -------------------------------------------------------------------------
  it('still delivers a tail final that arrives DURING the drain, after the mic is off', async () => {
    const mic = makeStream('mic-A');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(mic);
    const pm = createDeferredPluginManager();
    setupStore({ pluginManager: pm.manager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });

    let stopPromise!: Promise<void>;
    act(() => {
      stopPromise = result.current.stop();
    });
    expect(mic._track.readyState).toBe('ended');

    // The server's last final lands mid-drain — exactly what the drain is for.
    act(() => {
      pm.getOnTranscription()({
        text: 'the tail final',
        isFinal: true,
        vadStreamStartSec: 12,
        vadStreamEndSec: 13,
        confidence: 0.9,
      });
    });

    expect(mockStoreData.addTranscriptSegment).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'the tail final', isFinal: true, startTime: 12, endTime: 13 }),
    );
    // It arrived AFTER the microphone was released — the two are independent.
    expect(events.indexOf('track-stop:mic-A')).toBeLessThan(events.indexOf('segment:the tail final'));

    await act(async () => {
      pm.release();
      await stopPromise;
    });
  });

  it('resets the connection signals only after the drain completes', async () => {
    const mic = makeStream('mic-A');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(mic);
    const pm = createDeferredPluginManager();
    setupStore({ pluginManager: pm.manager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });

    // start() resets the drop latch too — this test is about the STOP-side one.
    mockStoreData.resetAudioDropped.mockClear();
    events.length = 0;

    let stopPromise!: Promise<void>;
    act(() => {
      stopPromise = result.current.stop();
    });

    // A transport-level reset done before destroy() would be overwritten by the
    // disconnect callbacks destroy() itself fires.
    expect(mockStoreData.resetAudioDropped).not.toHaveBeenCalled();

    await act(async () => {
      pm.release();
      await stopPromise;
    });

    expect(mockStoreData.resetAudioDropped).toHaveBeenCalledTimes(1);
    expect(mockStoreData.setSttConnectionState).toHaveBeenLastCalledWith('connected');
    expect(mockStoreData.setActivePipeline).toHaveBeenLastCalledWith(null);
    expect(events.indexOf('destroy-resolved')).toBeLessThan(events.indexOf('resetAudioDropped'));
  });
});

describe('useArcaAudio — stop() re-entrancy', () => {
  it('a second stop() issued while the first is draining joins it instead of starting a second drain', async () => {
    // This is the compat layer's real shape: `useAudioCapture.stopRecording()`
    // and `useArcaSpeechToText.stopTranscription()` both call this stop, both
    // guarding on a render-time `isCapturing` snapshot that is still true.
    const mic = makeStream('mic-A');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(mic);
    const pm = createDeferredPluginManager();
    setupStore({ pluginManager: pm.manager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.stop();
      second = result.current.stop();
    });

    expect(second).toBe(first);
    expect(pm.manager.destroy).toHaveBeenCalledTimes(1);
    expect(mic._track.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      pm.release();
      await Promise.all([first, second]);
    });
  });

  it('a stop() after a completed stop() is a no-op that releases nothing twice', async () => {
    const mic = makeStream('mic-A');
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(mic);
    const pm = createDeferredPluginManager();
    setupStore({ pluginManager: pm.manager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      await result.current.start({ deviceId: 'mic-A' });
    });
    await act(async () => {
      const p = result.current.stop();
      pm.release();
      await p;
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(mic._track.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() without a preceding start() resolves instead of throwing', async () => {
    const pm = createDeferredPluginManager();
    setupStore({ pluginManager: pm.manager });

    const { result } = renderHook(() => useArcaAudio());
    await act(async () => {
      const p = result.current.stop();
      pm.release();
      await expect(p).resolves.toBeUndefined();
    });
  });
});
