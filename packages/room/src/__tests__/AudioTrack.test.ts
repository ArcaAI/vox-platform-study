/**
 * @arcaai/room - AudioTrack Tests
 *
 * Comprehensive tests for the AudioTrack class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioTrack, type AudioTrackOptions } from '../core/AudioTrack.js';
import { TrackEvent } from '../events/TrackEvents.js';
import { TrackState, AudioFeature } from '../types/index.js';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockMediaStreamTrack(): MediaStreamTrack {
  return {
    kind: 'audio',
    id: `mock-track-${Date.now()}`,
    enabled: true,
    muted: false,
    readyState: 'live',
    label: 'Mock Audio Track',
    stop: vi.fn(),
    clone: vi.fn(),
    getSettings: vi.fn().mockReturnValue({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }),
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

function createMockMediaStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    id: `mock-stream-${Date.now()}`,
    active: true,
    getAudioTracks: vi.fn().mockReturnValue(tracks),
    getVideoTracks: vi.fn().mockReturnValue([]),
    getTracks: vi.fn().mockReturnValue(tracks),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
    onaddtrack: null,
    onremovetrack: null,
  } as unknown as MediaStream;
}

function createMockAudioContext(): AudioContext {
  const mockAnalyser = {
    fftSize: 2048,
    frequencyBinCount: 1024,
    getByteTimeDomainData: vi.fn(),
    getFloatTimeDomainData: vi.fn((arr: Float32Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.sin(i / 10) * 0.1;
      }
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockGain = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockSourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    mediaStream: null,
  };

  const mockDestination = {
    stream: createMockMediaStream([createMockMediaStreamTrack()]),
  };

  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    baseLatency: 0.01,
    destination: {} as AudioDestinationNode,
    createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
    createGain: vi.fn().mockReturnValue(mockGain),
    createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
    createMediaStreamDestination: vi.fn().mockReturnValue(mockDestination),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as AudioContext;
}

// Mock MediaStream class
class MockMediaStreamClass {
  private tracks: MediaStreamTrack[];
  id: string;
  active: boolean;

  constructor(tracks?: MediaStreamTrack[]) {
    this.tracks = tracks ?? [];
    this.id = `mock-stream-${Date.now()}`;
    this.active = true;
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
  dispatchEvent = vi.fn().mockReturnValue(true);
  onaddtrack = null;
  onremovetrack = null;
}

// ============================================================================
// Tests
// ============================================================================

describe('AudioTrack', () => {
  let track: AudioTrack;
  let mockAudioContext: AudioContext;

  beforeEach(() => {
    mockAudioContext = createMockAudioContext();

    const mockMediaTrack = createMockMediaStreamTrack();

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStreamClass([mockMediaTrack])),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    // Mock MediaStream constructor
    vi.stubGlobal('MediaStream', MockMediaStreamClass);

    track = new AudioTrack({ audioContext: mockAudioContext });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('should create an AudioTrack with default options', () => {
      const defaultTrack = new AudioTrack();
      expect(defaultTrack).toBeInstanceOf(AudioTrack);
      expect(defaultTrack.kind).toBe('audio');
    });

    it('should create an AudioTrack with custom options', () => {
      const customTrack = new AudioTrack({
        audioContext: mockAudioContext,
        noiseSuppression: true,
        echoCancellation: true,
      });
      expect(customTrack).toBeInstanceOf(AudioTrack);
    });

    it('should start in IDLE state', () => {
      expect(track.getState()).toBe(TrackState.IDLE);
    });
  });

  describe('initialize', () => {
    it('should initialize from microphone', async () => {
      await track.initialize();
      expect(track.getState()).toBe(TrackState.ACTIVE);
    });

    it('should initialize with options', async () => {
      await track.initialize({
        noiseSuppression: true,
        echoCancellation: true,
      });
      expect(track.getState()).toBe(TrackState.ACTIVE);
    });

    it('should throw if already initialized', async () => {
      await track.initialize();

      await expect(track.initialize()).rejects.toThrow();
    });
  });

  describe('initializeFromTrack', () => {
    it('should initialize from existing MediaStreamTrack', async () => {
      const mockMediaTrack = createMockMediaStreamTrack();
      await track.initializeFromTrack(mockMediaTrack);

      expect(track.getState()).toBe(TrackState.ACTIVE);
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      await track.initialize();
    });

    it('should stop the track', async () => {
      await track.stop();
      expect(track.getState()).toBe(TrackState.ENDED);
    });

    it('should emit Ended event', async () => {
      const endedHandler = vi.fn();
      track.on(TrackEvent.Ended, endedHandler);

      await track.stop();

      expect(endedHandler).toHaveBeenCalled();
    });

    it('should be idempotent', async () => {
      await track.stop();
      await track.stop();

      expect(track.getState()).toBe(TrackState.ENDED);
    });
  });

  describe('mute/unmute', () => {
    beforeEach(async () => {
      await track.initialize();
    });

    it('should mute the track', () => {
      track.mute();
      expect(track.isMuted()).toBe(true);
    });

    it('should unmute the track', () => {
      track.mute();
      track.unmute();
      expect(track.isMuted()).toBe(false);
    });

    it('should emit Muted event', () => {
      const mutedHandler = vi.fn();
      track.on(TrackEvent.Muted, mutedHandler);

      track.mute();

      expect(mutedHandler).toHaveBeenCalled();
    });

    it('should emit Unmuted event', () => {
      const unmutedHandler = vi.fn();
      track.on(TrackEvent.Unmuted, unmutedHandler);

      track.mute();
      track.unmute();

      expect(unmutedHandler).toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('should return IDLE initially', () => {
      expect(track.getState()).toBe(TrackState.IDLE);
    });

    it('should return ACTIVE after initialize', async () => {
      await track.initialize();
      expect(track.getState()).toBe(TrackState.ACTIVE);
    });

    it('should return ENDED after stop', async () => {
      await track.initialize();
      await track.stop();
      expect(track.getState()).toBe(TrackState.ENDED);
    });
  });

  describe('isMuted', () => {
    beforeEach(async () => {
      await track.initialize();
    });

    it('should return false initially after initialize', () => {
      expect(track.isMuted()).toBe(false);
    });

    it('should return true after mute', () => {
      track.mute();
      expect(track.isMuted()).toBe(true);
    });
  });

  describe('mediaStreamTrack', () => {
    it('should return null before initialize', () => {
      expect(track.mediaStreamTrack).toBeNull();
    });

    it('should return MediaStreamTrack after initialize', async () => {
      await track.initialize();
      expect(track.mediaStreamTrack).toBeDefined();
    });
  });

  describe('setAudioContext', () => {
    it('should set the AudioContext', () => {
      const newContext = createMockAudioContext();
      track.setAudioContext(newContext);

      expect(track).toBeInstanceOf(AudioTrack);
    });
  });

  describe('getFeatures', () => {
    beforeEach(async () => {
      await track.initialize();
    });

    it('should return feature map', () => {
      const features = track.getFeatures();
      expect(features).toBeInstanceOf(Map);
    });

    it('should include standard audio features', () => {
      const features = track.getFeatures();
      expect(features.has(AudioFeature.ECHO_CANCELLATION)).toBe(true);
      expect(features.has(AudioFeature.NOISE_SUPPRESSION)).toBe(true);
      expect(features.has(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);
    });
  });

  describe('events', () => {
    beforeEach(async () => {
      await track.initialize();
    });

    it('should handle subscription and unsubscription', async () => {
      const handler = vi.fn();
      const unsub = track.on(TrackEvent.Ended, handler);

      unsub();

      await track.stop();

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle once subscription', () => {
      const handler = vi.fn();
      track.once(TrackEvent.Muted, handler);

      track.mute();
      track.unmute();
      track.mute();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('TrackState enum', () => {
    it('should have correct values', () => {
      expect(TrackState.IDLE).toBe('idle');
      expect(TrackState.INITIALIZING).toBe('initializing');
      expect(TrackState.ACTIVE).toBe('active');
      expect(TrackState.MUTED).toBe('muted');
      expect(TrackState.ENDED).toBe('ended');
    });
  });
});

describe('TrackEvent enum', () => {
  it('should have correct values', () => {
    expect(TrackEvent.Muted).toBe('muted');
    expect(TrackEvent.Unmuted).toBe('unmuted');
    expect(TrackEvent.Ended).toBe('ended');
    expect(TrackEvent.Restarted).toBe('restarted');
    expect(TrackEvent.ProcessorUpdate).toBe('processorUpdate');
    expect(TrackEvent.FeatureUpdate).toBe('featureUpdate');
    expect(TrackEvent.AudioLevelUpdate).toBe('audioLevelUpdate');
  });
});

// ============================================================================
// W1-4 — track 'ended' handling cleans up resources
// ============================================================================

describe('AudioTrack track-ended handling (W1-4)', () => {
  let mockAudioContext: AudioContext;
  let mockMediaTrack: MediaStreamTrack;
  let mockSourceNode: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  let track: AudioTrack;

  beforeEach(async () => {
    mockSourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    mockAudioContext = {
      state: 'running',
      sampleRate: 48000,
      currentTime: 0,
      destination: {} as AudioDestinationNode,
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 2048,
        frequencyBinCount: 1024,
        getFloatTimeDomainData: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createGain: vi.fn(),
      createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
      createMediaStreamDestination: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;

    mockMediaTrack = createMockMediaStreamTrack();

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStreamClass([mockMediaTrack])),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
    vi.stubGlobal('MediaStream', MockMediaStreamClass);

    track = new AudioTrack({ audioContext: mockAudioContext, audioLevelInterval: 10 });
    await track.initialize();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it('should transition state to ENDED when MediaStreamTrack.onended fires', () => {
    expect(track.getState()).toBe(TrackState.ACTIVE);
    expect(typeof mockMediaTrack.onended).toBe('function');

    (mockMediaTrack.onended as () => void)();

    expect(track.getState()).toBe(TrackState.ENDED);
  });

  it('should emit TrackEvent.Ended exactly once when MediaStreamTrack.onended fires', () => {
    const endedHandler = vi.fn();
    track.on(TrackEvent.Ended, endedHandler);

    (mockMediaTrack.onended as () => void)();

    expect(endedHandler).toHaveBeenCalledTimes(1);
  });

  it('should disconnect the source node and clear the level monitor on track-ended', async () => {
    expect(mockSourceNode.connect).toHaveBeenCalled();

    (mockMediaTrack.onended as () => void)();
    // Wait one tick so the async cleanup settles.
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(mockSourceNode.disconnect).toHaveBeenCalled();
  });

  it('should make subsequent stop() a no-op (no double-Ended emit)', async () => {
    const endedHandler = vi.fn();
    track.on(TrackEvent.Ended, endedHandler);

    (mockMediaTrack.onended as () => void)();
    await new Promise<void>((r) => setTimeout(r, 0));
    await track.stop();

    expect(endedHandler).toHaveBeenCalledTimes(1);
    expect(track.getState()).toBe(TrackState.ENDED);
  });
});

// ============================================================================
// W1-6 — Float32Array preallocation in updateAudioLevel
// ============================================================================

describe('AudioTrack level-monitor allocation budget (W1-6)', () => {
  it('should reuse a single Float32Array buffer across many ticks', async () => {
    vi.useFakeTimers();

    const passedBuffers = new Set<Float32Array>();
    const mockAnalyser = {
      fftSize: 2048,
      frequencyBinCount: 1024,
      getFloatTimeDomainData: vi.fn((arr: Float32Array) => {
        passedBuffers.add(arr);
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    const localCtx = {
      state: 'running',
      sampleRate: 48000,
      currentTime: 0,
      destination: {} as AudioDestinationNode,
      createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
      createGain: vi.fn().mockReturnValue({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }),
      createMediaStreamDestination: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;

    const mockMediaTrack = createMockMediaStreamTrack();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStreamClass([mockMediaTrack])),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
    vi.stubGlobal('MediaStream', MockMediaStreamClass);

    const localTrack = new AudioTrack({ audioContext: localCtx, audioLevelInterval: 1 });
    await localTrack.initialize();

    // Drain queued microtasks before fake-timer advancement.
    await Promise.resolve();

    // 1000 ticks at 1ms interval.
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockAnalyser.getFloatTimeDomainData.mock.calls.length).toBeGreaterThanOrEqual(500);
    // Critical assertion: only ONE buffer instance was passed to getFloatTimeDomainData
    // across all those ticks.
    expect(passedBuffers.size).toBe(1);

    vi.useRealTimers();
    await localTrack.stop();
    vi.unstubAllGlobals();
  });
});
