/**
 * @arcaai/room - Room Tests
 *
 * Comprehensive tests for the Room class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Room, RoomEvent, RoomState, createLocalTracks } from '../core/Room.js';
import { AudioContextManager } from '../core/AudioContextManager.js';
import { RoomErrorCode } from '../types/index.js';
import {
  RoomPermissionError,
  RoomDeviceError,
  RoomSecurityError,
  RoomConstraintError,
  RoomUnknownError,
} from '../core/RoomErrors.js';

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
    getFloatTimeDomainData: vi.fn(),
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

// ============================================================================
// Tests
// ============================================================================

describe('Room', () => {
  let room: Room;
  let mockAudioContext: AudioContext;

  beforeEach(() => {
    // Reset AudioContextManager singleton
    AudioContextManager.resetInstance();

    mockAudioContext = createMockAudioContext();

    // Mock navigator.mediaDevices
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(
          createMockMediaStream([createMockMediaStreamTrack()])
        ),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    // Create room with custom AudioContext
    room = new Room({ audioContext: mockAudioContext });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    AudioContextManager.resetInstance();
  });

  describe('constructor', () => {
    it('should create a room with default options', () => {
      const defaultRoom = new Room();
      expect(defaultRoom).toBeInstanceOf(Room);
      expect(defaultRoom.getState()).toBe(RoomState.Disconnected);
    });

    it('should create a room with custom options', () => {
      const customRoom = new Room({
        latencyHint: 'playback',
        sampleRate: 44100,
      });
      expect(customRoom).toBeInstanceOf(Room);
    });

    it('should accept custom AudioContext', () => {
      const customRoom = new Room({ audioContext: mockAudioContext });
      expect(customRoom).toBeInstanceOf(Room);
    });
  });

  describe('getState', () => {
    it('should return Disconnected initially', () => {
      expect(room.getState()).toBe(RoomState.Disconnected);
    });

    it('should return Connected after connect', async () => {
      await room.connect();
      expect(room.getState()).toBe(RoomState.Connected);
    });

    it('should return Disconnected after disconnect', async () => {
      await room.connect();
      await room.disconnect();
      expect(room.getState()).toBe(RoomState.Disconnected);
    });
  });

  describe('isConnected', () => {
    it('should return false initially', () => {
      expect(room.isConnected()).toBe(false);
    });

    it('should return true after connect', async () => {
      await room.connect();
      expect(room.isConnected()).toBe(true);
    });

    it('should return false after disconnect', async () => {
      await room.connect();
      await room.disconnect();
      expect(room.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('should connect successfully', async () => {
      await room.connect();
      expect(room.isConnected()).toBe(true);
    });

    it('should emit Connected event', async () => {
      const connectedHandler = vi.fn();
      room.on(RoomEvent.Connected, connectedHandler);

      await room.connect();

      expect(connectedHandler).toHaveBeenCalled();
    });

    it('should be idempotent', async () => {
      await room.connect();
      await room.connect();
      expect(room.isConnected()).toBe(true);
    });

    it('should provide AudioContext after connect', async () => {
      await room.connect();
      const ctx = room.getAudioContext();
      expect(ctx).toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('should disconnect successfully', async () => {
      await room.connect();
      await room.disconnect();
      expect(room.isConnected()).toBe(false);
    });

    it('should emit Disconnected event', async () => {
      const disconnectedHandler = vi.fn();
      room.on(RoomEvent.Disconnected, disconnectedHandler);

      await room.connect();
      await room.disconnect();

      expect(disconnectedHandler).toHaveBeenCalled();
    });

    it('should clear local tracks', async () => {
      await room.connect();

      // Create a local track first - we need to mock getUserMedia
      const mockTrack = createMockMediaStreamTrack();
      const mockStream = createMockMediaStream([mockTrack]);
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(mockStream),
          enumerateDevices: vi.fn().mockResolvedValue([]),
        },
      });

      await room.disconnect();

      expect(room.getLocalTracks()).toHaveLength(0);
    });
  });

  describe('getAudioContext', () => {
    it('should return null when not connected', () => {
      const newRoom = new Room();
      expect(newRoom.getAudioContext()).toBeNull();
    });

    it('should return AudioContext when connected', async () => {
      await room.connect();
      const ctx = room.getAudioContext();
      expect(ctx).toBe(mockAudioContext);
    });
  });

  describe('getLocalTracks', () => {
    it('should return empty array initially', () => {
      expect(room.getLocalTracks()).toEqual([]);
    });
  });

  describe('resumeAudio', () => {
    it('should handle resumeAudio when context is running', async () => {
      await room.connect();
      await room.resumeAudio();

      // When context is already running, resume may not be called
      // The method should still complete successfully
      expect(room.canPlayAudio()).toBe(true);
    });

    it('should resume audio context when suspended', async () => {
      // Create a room with a suspended AudioContext
      const suspendedContext = createMockAudioContext();
      (suspendedContext as { state: string }).state = 'suspended';

      AudioContextManager.resetInstance();
      const suspendedRoom = new Room({ audioContext: suspendedContext });

      await suspendedRoom.connect();
      await suspendedRoom.resumeAudio();

      expect(suspendedContext.resume).toHaveBeenCalled();
    });

    it('should emit AudioPlaybackStatusChanged event', async () => {
      const statusHandler = vi.fn();
      room.on(RoomEvent.AudioPlaybackStatusChanged, statusHandler);

      await room.connect();
      await room.resumeAudio();

      expect(statusHandler).toHaveBeenCalledWith({ canPlayback: true });
    });
  });

  describe('canPlayAudio', () => {
    it('should return false when not connected', () => {
      const newRoom = new Room();
      expect(newRoom.canPlayAudio()).toBe(false);
    });

    it('should return true when AudioContext is running', async () => {
      await room.connect();
      expect(room.canPlayAudio()).toBe(true);
    });
  });

  describe('getSampleRate', () => {
    it('should return undefined when not connected', () => {
      const newRoom = new Room();
      expect(newRoom.getSampleRate()).toBeUndefined();
    });

    it('should return sample rate when connected', async () => {
      await room.connect();
      expect(room.getSampleRate()).toBe(48000);
    });
  });

  describe('AudioMixer integration', () => {
    it('should create AudioMixer when webAudioMix is true', async () => {
      const mixRoom = new Room({ audioContext: mockAudioContext, webAudioMix: true });
      await mixRoom.connect();
      expect(mixRoom.getMixer()).not.toBeNull();
      await mixRoom.disconnect();
    });

    it('should not create AudioMixer when webAudioMix is false', async () => {
      AudioContextManager.resetInstance();
      const noMixRoom = new Room({ audioContext: mockAudioContext, webAudioMix: false });
      await noMixRoom.connect();
      expect(noMixRoom.getMixer()).toBeNull();
      await noMixRoom.disconnect();
    });

    it('should dispose AudioMixer on disconnect', async () => {
      const mixRoom = new Room({ audioContext: mockAudioContext, webAudioMix: true });
      await mixRoom.connect();
      const mixer = mixRoom.getMixer();
      expect(mixer).not.toBeNull();
      await mixRoom.disconnect();
      expect(mixRoom.getMixer()).toBeNull();
    });
  });

  describe('events', () => {
    it('should handle Connected event subscription', async () => {
      const handler = vi.fn();
      room.on(RoomEvent.Connected, handler);

      await room.connect();

      expect(handler).toHaveBeenCalled();
    });

    it('should handle Disconnected event subscription', async () => {
      const handler = vi.fn();
      room.on(RoomEvent.Disconnected, handler);

      await room.connect();
      await room.disconnect();

      expect(handler).toHaveBeenCalled();
    });

    it('should handle AudioPlaybackStatusChanged event', async () => {
      const handler = vi.fn();
      room.on(RoomEvent.AudioPlaybackStatusChanged, handler);

      await room.connect();
      await room.resumeAudio();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ canPlayback: expect.any(Boolean) })
      );
    });

    it('should allow unsubscribing from events', async () => {
      const handler = vi.fn();
      const unsub = room.on(RoomEvent.Connected, handler);

      unsub();
      await room.connect();

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe('createLocalTracks', () => {
  beforeEach(() => {
    // Reset AudioContextManager singleton
    AudioContextManager.resetInstance();

    const mockTrack = {
      kind: 'audio',
      id: 'mock-track-id',
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

    const mockStream = {
      id: 'mock-stream-id',
      active: true,
      getAudioTracks: () => [mockTrack],
      getVideoTracks: () => [],
      getTracks: () => [mockTrack],
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
      clone: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn().mockReturnValue(true),
    } as unknown as MediaStream;

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    AudioContextManager.resetInstance();
  });

  it('should create local tracks', async () => {
    const tracks = await createLocalTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toBeDefined();
  });

  it('should create tracks with options', async () => {
    const tracks = await createLocalTracks({
      noiseSuppression: true,
      echoCancellation: true,
    });
    expect(tracks).toHaveLength(1);
  });
});

// ============================================================================
// W1-3 — typed getUserMedia errors from createLocalTracks
// ============================================================================

describe('createLocalTracks typed errors (W1-3)', () => {
  function makeDOMException(name: string, message?: string): DOMException {
    // jsdom supports DOMException constructor.
    return new DOMException(message ?? name, name);
  }

  beforeEach(() => {
    AudioContextManager.resetInstance();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    AudioContextManager.resetInstance();
  });

  it('should rethrow NotAllowedError as RoomPermissionError with code "mic_permission_denied"', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(makeDOMException('NotAllowedError', 'Permission denied')),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    const err = await createLocalTracks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomPermissionError);
    expect((err as RoomPermissionError).code).toBe('mic_permission_denied');
    expect((err as RoomPermissionError).name).toBe('RoomPermissionError');
  });

  it('should rethrow NotFoundError as RoomDeviceError with code "mic_not_found"', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(makeDOMException('NotFoundError', 'No mic')),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    const err = await createLocalTracks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomDeviceError);
    expect((err as RoomDeviceError).code).toBe('mic_not_found');
  });

  it('should rethrow SecurityError as RoomSecurityError with code "mic_insecure_context"', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(makeDOMException('SecurityError', 'Insecure')),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    const err = await createLocalTracks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomSecurityError);
    expect((err as RoomSecurityError).code).toBe('mic_insecure_context');
  });

  it('should rethrow OverconstrainedError as RoomConstraintError with code "mic_constraints_unsupported"', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(makeDOMException('OverconstrainedError', 'Bad constraints')),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    const err = await createLocalTracks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomConstraintError);
    expect((err as RoomConstraintError).code).toBe('mic_constraints_unsupported');
  });

  it('should rethrow unknown errors as RoomUnknownError', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new Error('something exotic')),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });

    const err = await createLocalTracks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoomUnknownError);
  });
});

describe('RoomState enum', () => {
  it('should have correct values', () => {
    expect(RoomState.Disconnected).toBe('disconnected');
    expect(RoomState.Connecting).toBe('connecting');
    expect(RoomState.Connected).toBe('connected');
    expect(RoomState.Error).toBe('error');
  });
});

describe('RoomEvent enum', () => {
  it('should have correct values', () => {
    expect(RoomEvent.Connected).toBe('connected');
    expect(RoomEvent.Disconnected).toBe('disconnected');
    expect(RoomEvent.LocalTrackCreated).toBe('localTrackCreated');
    expect(RoomEvent.LocalTrackRemoved).toBe('localTrackRemoved');
    expect(RoomEvent.AudioPlaybackStatusChanged).toBe('audioPlaybackStatusChanged');
    expect(RoomEvent.Error).toBe('error');
  });
});
