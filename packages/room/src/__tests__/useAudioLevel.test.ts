/**
 * @arcaai/room - useAudioLevel Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAudioLevel } from '../hooks/useAudioLevel.js';
import { AudioTrack } from '../core/AudioTrack.js';

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

interface MockAnalyserNode {
  fftSize: number;
  smoothingTimeConstant: number;
  getFloatTimeDomainData: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeAudioContext(): AudioContext & {
  __createAnalyserMock: ReturnType<typeof vi.fn>;
  __sourceNodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
  __analysers: MockAnalyserNode[];
} {
  const sourceNodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const analysers: MockAnalyserNode[] = [];

  const createAnalyser = vi.fn(() => {
    const a: MockAnalyserNode = {
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      getFloatTimeDomainData: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    analysers.push(a);
    return a;
  });

  const createMediaStreamSource = vi.fn(() => {
    const node = { connect: vi.fn(), disconnect: vi.fn() };
    sourceNodes.push(node);
    return node;
  });

  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    createAnalyser,
    createGain: vi.fn(),
    createMediaStreamSource,
    createMediaStreamDestination: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    __createAnalyserMock: createAnalyser,
    __sourceNodes: sourceNodes,
    __analysers: analysers,
  } as unknown as AudioContext & {
    __createAnalyserMock: ReturnType<typeof vi.fn>;
    __sourceNodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
    __analysers: MockAnalyserNode[];
  };
}

// ============================================================================
// Tests — W2-4 shared analyser
// ============================================================================

describe('useAudioLevel shared analyser (W2-4)', () => {
  let mockMediaTrack: MediaStreamTrack;

  beforeEach(() => {
    mockMediaTrack = makeMediaTrack();
    vi.stubGlobal('MediaStream', MockMediaStreamClass);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStreamClass([mockMediaTrack])),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should create exactly one AnalyserNode for two consumers of the same track', async () => {
    const ctx = makeAudioContext();
    // monitorAudioLevel: false — disable AudioTrack's own internal analyser so
    // the only analyser observable in this test is the hook-managed one.
    const track = new AudioTrack({ audioContext: ctx, monitorAudioLevel: false });
    await track.initialize();

    expect(ctx.__createAnalyserMock).toHaveBeenCalledTimes(0);

    const { unmount: unmountA } = renderHook(() => useAudioLevel(track));
    const { unmount: unmountB } = renderHook(() => useAudioLevel(track));

    // Only one analyser node should have been created — shared across both
    // consumers via internal ref-counting.
    expect(ctx.__createAnalyserMock).toHaveBeenCalledTimes(1);
    expect(ctx.__analysers).toHaveLength(1);

    unmountA();
    // First unmount must NOT tear down the analyser — the second consumer
    // still holds a reference.
    expect(ctx.__analysers[0]?.disconnect).not.toHaveBeenCalled();

    unmountB();
    // Last consumer unmounted — analyser is torn down.
    expect(ctx.__analysers[0]?.disconnect).toHaveBeenCalled();

    await track.stop();
  });

  it('should not create any analyser if the track has no AudioContext or sourceMediaStreamTrack', () => {
    const dummyTrack = new AudioTrack();
    // No initialize() — track has no source MediaStreamTrack and no audio
    // context. The hook must not blow up; it just returns the default level
    // info.
    const { result, unmount } = renderHook(() => useAudioLevel(dummyTrack));
    expect(result.current.level).toBe(0);
    expect(result.current.isSpeaking).toBe(false);
    unmount();
  });

  it('should re-acquire after a full unmount/re-mount cycle', async () => {
    const ctx = makeAudioContext();
    const track = new AudioTrack({ audioContext: ctx, monitorAudioLevel: false });
    await track.initialize();

    const { unmount } = renderHook(() => useAudioLevel(track));
    expect(ctx.__createAnalyserMock).toHaveBeenCalledTimes(1);
    unmount();

    // Mount a fresh consumer — should produce a brand-new analyser since
    // the previous shared one was torn down.
    const { unmount: unmount2 } = renderHook(() => useAudioLevel(track));
    expect(ctx.__createAnalyserMock).toHaveBeenCalledTimes(2);
    unmount2();

    await track.stop();
  });
});
