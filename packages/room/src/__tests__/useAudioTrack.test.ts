/**
 * @arcaai/room - useAudioTrack Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioTrack } from '../hooks/useAudioTrack.js';
import { AudioTrack } from '../core/AudioTrack.js';
import { TrackState } from '../types/index.js';

// ============================================================================
// Mock factories
// ============================================================================

class MockMediaStreamClass {
  private tracks: MediaStreamTrack[];
  id = 'mock-stream';
  active = true;
  constructor(tracks?: MediaStreamTrack[]) {
    this.tracks = tracks ?? [];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return [];
  }
  getTracks() {
    return this.tracks;
  }
  addTrack = vi.fn();
  removeTrack = vi.fn();
  clone = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn();
}

function makeMediaTrack(): MediaStreamTrack {
  return {
    kind: 'audio',
    id: 'mock-media-track',
    enabled: true,
    muted: false,
    readyState: 'live',
    label: 'Mock',
    stop: vi.fn(),
    clone: vi.fn(),
    getSettings: vi.fn().mockReturnValue({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    getConstraints: vi.fn().mockReturnValue({}),
    getCapabilities: vi.fn().mockReturnValue({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
    onended: null,
    onmute: null,
    onunmute: null,
  } as unknown as MediaStreamTrack;
}

function makeAudioContext(): AudioContext {
  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    createAnalyser: vi.fn().mockReturnValue({
      fftSize: 2048,
      getFloatTimeDomainData: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createGain: vi.fn(),
    createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }),
    createMediaStreamDestination: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
}

// ============================================================================
// Tests
// ============================================================================

describe('useAudioTrack ref ordering (W1-5)', () => {
  let mockMediaTrack: MediaStreamTrack;

  beforeEach(() => {
    mockMediaTrack = makeMediaTrack();
    vi.stubGlobal('MediaStream', MockMediaStreamClass);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should stop the in-flight track when component unmounts before initialize() resolves', async () => {
    // Gate: the hook awaits this promise; we resolve it after unmount.
    let releaseGetUserMedia!: (stream: MediaStream) => void;
    const gumPromise = new Promise<MediaStream>((resolve) => {
      releaseGetUserMedia = (stream) => resolve(stream);
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockReturnValue(gumPromise),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    const audioContext = makeAudioContext();

    // Spy on AudioTrack.stop — must be called by the cleanup path even
    // though `initialize()` has not yet resolved.
    const stopSpy = vi.spyOn(AudioTrack.prototype, 'stop');

    const { result, unmount } = renderHook(() => useAudioTrack({ audioContext }));

    // Kick off startCapture without awaiting; record any rejection.
    let startError: unknown = null;
    void act(async () => {
      try {
        await result.current.startCapture();
      } catch (e) {
        startError = e;
      }
    });

    // Yield so the synchronous prelude of startCapture runs.
    await Promise.resolve();
    await Promise.resolve();

    // Unmount before getUserMedia resolves.
    unmount();

    // Resolve gUM and let the rest of initialize() drain.
    releaseGetUserMedia(new MockMediaStreamClass([mockMediaTrack]) as unknown as MediaStream);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Critical: stop() must have been called from the cleanup effect.
    expect(stopSpy).toHaveBeenCalled();

    // Fence: ensure no rejection slipped past act() that would fail tests.
    void startError;
    stopSpy.mockRestore();
  });

  it('should not double-stop when initialize() rejects (ref cleared on init failure)', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    const audioContext = makeAudioContext();
    const stopSpy = vi.spyOn(AudioTrack.prototype, 'stop');

    const { result, unmount } = renderHook(() => useAudioTrack({ audioContext }));

    // Drive startCapture to its rejection so trackRef.current is cleared.
    await act(async () => {
      try {
        await result.current.startCapture();
      } catch {
        /* expected */
      }
    });

    // Unmount: cleanup must NOT call stop again — trackRef should already
    // be null because initialize rejected.
    const stopCallsBeforeUnmount = stopSpy.mock.calls.length;
    unmount();
    expect(stopSpy.mock.calls.length).toBe(stopCallsBeforeUnmount);

    stopSpy.mockRestore();
  });
});
