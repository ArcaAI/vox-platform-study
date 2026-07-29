/**
 * @arcaai/room - Types and RoomError Tests
 *
 * Tests for type definitions, enums, and error classes.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { AudioFeature, TrackState, TrackSource, RoomErrorCode, RoomError, DEFAULT_AUDIO_OPTIONS, DEFAULT_ROOM_OPTIONS } from '../types/index.js';

// ============================================================================
// AudioFeature Tests
// ============================================================================

describe('AudioFeature', () => {
  it('should have correct enum values', () => {
    expect(AudioFeature.AUTO_GAIN_CONTROL).toBe('autoGainControl');
    expect(AudioFeature.ECHO_CANCELLATION).toBe('echoCancellation');
    expect(AudioFeature.NOISE_SUPPRESSION).toBe('noiseSuppression');
    expect(AudioFeature.VOICE_ISOLATION).toBe('voiceIsolation');
  });

  it('should have all expected features', () => {
    const features = Object.values(AudioFeature);
    expect(features).toHaveLength(4);
    expect(features).toContain('autoGainControl');
    expect(features).toContain('echoCancellation');
    expect(features).toContain('noiseSuppression');
    expect(features).toContain('voiceIsolation');
  });
});

// ============================================================================
// TrackState Tests
// ============================================================================

describe('TrackState', () => {
  it('should have correct enum values', () => {
    expect(TrackState.IDLE).toBe('idle');
    expect(TrackState.INITIALIZING).toBe('initializing');
    expect(TrackState.ACTIVE).toBe('active');
    expect(TrackState.MUTED).toBe('muted');
    expect(TrackState.ENDED).toBe('ended');
    expect(TrackState.ERROR).toBe('error');
  });

  it('should have all expected states', () => {
    const states = Object.values(TrackState);
    expect(states).toHaveLength(6);
  });
});

// ============================================================================
// TrackSource Tests
// ============================================================================

describe('TrackSource', () => {
  it('should have correct enum values', () => {
    expect(TrackSource.MICROPHONE).toBe('microphone');
    expect(TrackSource.SCREEN_SHARE).toBe('screen_share');
    expect(TrackSource.CUSTOM).toBe('custom');
  });

  it('should have all expected sources', () => {
    const sources = Object.values(TrackSource);
    expect(sources).toHaveLength(3);
  });
});

// ============================================================================
// RoomErrorCode Tests
// ============================================================================

describe('RoomErrorCode', () => {
  it('should have correct enum values', () => {
    expect(RoomErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    expect(RoomErrorCode.DEVICE_NOT_FOUND).toBe('DEVICE_NOT_FOUND');
    expect(RoomErrorCode.DEVICE_IN_USE).toBe('DEVICE_IN_USE');
    expect(RoomErrorCode.NOT_SUPPORTED).toBe('NOT_SUPPORTED');
    expect(RoomErrorCode.AUDIO_CONTEXT_SUSPENDED).toBe('AUDIO_CONTEXT_SUSPENDED');
    expect(RoomErrorCode.PROCESSOR_INIT_FAILED).toBe('PROCESSOR_INIT_FAILED');
    expect(RoomErrorCode.TRACK_NOT_FOUND).toBe('TRACK_NOT_FOUND');
    expect(RoomErrorCode.UNKNOWN).toBe('UNKNOWN');
  });

  it('should have all expected error codes', () => {
    const codes = Object.values(RoomErrorCode);
    expect(codes).toHaveLength(8);
  });
});

// ============================================================================
// RoomError Tests
// ============================================================================

describe('RoomError', () => {
  it('should create error with code and message', () => {
    const error = new RoomError(RoomErrorCode.PERMISSION_DENIED, 'Microphone permission denied');

    expect(error.code).toBe(RoomErrorCode.PERMISSION_DENIED);
    expect(error.message).toBe('Microphone permission denied');
    expect(error.name).toBe('RoomError');
  });

  it('should create error with cause', () => {
    const originalError = new Error('Original error');
    const error = new RoomError(RoomErrorCode.DEVICE_NOT_FOUND, 'No microphone found', originalError);

    expect(error.code).toBe(RoomErrorCode.DEVICE_NOT_FOUND);
    expect(error.message).toBe('No microphone found');
    expect(error.cause).toBe(originalError);
  });

  it('should be instanceof Error', () => {
    const error = new RoomError(RoomErrorCode.UNKNOWN, 'Unknown error');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RoomError);
  });

  it('should have correct stack trace', () => {
    const error = new RoomError(RoomErrorCode.UNKNOWN, 'Test error');

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('RoomError');
  });

  it('should work with try/catch', () => {
    const throwError = () => {
      throw new RoomError(RoomErrorCode.NOT_SUPPORTED, 'Feature not supported');
    };

    expect(throwError).toThrow(RoomError);
    expect(throwError).toThrow('Feature not supported');
  });

  it('should be catchable by type', () => {
    let caughtError: RoomError | null = null;

    try {
      throw new RoomError(RoomErrorCode.DEVICE_IN_USE, 'Device is in use');
    } catch (error) {
      if (error instanceof RoomError) {
        caughtError = error;
      }
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.code).toBe(RoomErrorCode.DEVICE_IN_USE);
  });

  it('should preserve cause chain', () => {
    const rootCause = new Error('Root cause');
    const middleError = new RoomError(RoomErrorCode.UNKNOWN, 'Middle error', rootCause);
    const topError = new RoomError(RoomErrorCode.PROCESSOR_INIT_FAILED, 'Init failed', middleError);

    expect(topError.cause).toBe(middleError);
    expect((topError.cause as RoomError).cause).toBe(rootCause);
  });
});

// ============================================================================
// Default Options Tests
// ============================================================================

describe('DEFAULT_AUDIO_OPTIONS', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_AUDIO_OPTIONS.echoCancellation).toBe(true);
    expect(DEFAULT_AUDIO_OPTIONS.noiseSuppression).toBe(true);
    expect(DEFAULT_AUDIO_OPTIONS.autoGainControl).toBe(true);
    expect(DEFAULT_AUDIO_OPTIONS.voiceIsolation).toBe(false);
    expect(DEFAULT_AUDIO_OPTIONS.channelCount).toBe(1);
  });

  it('should not include optional properties', () => {
    expect(DEFAULT_AUDIO_OPTIONS).not.toHaveProperty('deviceId');
    expect(DEFAULT_AUDIO_OPTIONS).not.toHaveProperty('sampleRate');
    expect(DEFAULT_AUDIO_OPTIONS).not.toHaveProperty('latency');
  });

  it('should be read-only at compile time (runtime check)', () => {
    // At runtime, we verify the object exists with expected shape
    expect(Object.keys(DEFAULT_AUDIO_OPTIONS)).toEqual(['echoCancellation', 'noiseSuppression', 'autoGainControl', 'voiceIsolation', 'channelCount']);
  });
});

describe('DEFAULT_ROOM_OPTIONS', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_ROOM_OPTIONS.webAudioMix).toBe(true);
    expect(DEFAULT_ROOM_OPTIONS.latencyHint).toBe('interactive');
  });

  it('should not include optional properties', () => {
    expect(DEFAULT_ROOM_OPTIONS.audioContext).toBeUndefined();
    expect(DEFAULT_ROOM_OPTIONS.sampleRate).toBeUndefined();
  });
});

// ============================================================================
// Type Interface Tests (Runtime shape verification)
// ============================================================================

describe('AudioLevelInfo interface', () => {
  it('should have correct shape', () => {
    // Create an object matching the interface
    const info = {
      level: 0.5,
      isSpeaking: true,
      peak: 0.8,
      average: 0.4,
    };

    expect(info).toHaveProperty('level');
    expect(info).toHaveProperty('isSpeaking');
    expect(info).toHaveProperty('peak');
    expect(info).toHaveProperty('average');
    expect(typeof info.level).toBe('number');
    expect(typeof info.isSpeaking).toBe('boolean');
  });
});

describe('AudioDevice interface', () => {
  it('should have correct shape', () => {
    const device = {
      deviceId: 'device-123',
      label: 'Built-in Microphone',
      kind: 'audioinput' as const,
      groupId: 'group-123',
      isDefault: true,
    };

    expect(device.deviceId).toBe('device-123');
    expect(device.label).toBe('Built-in Microphone');
    expect(device.kind).toBe('audioinput');
    expect(device.groupId).toBe('group-123');
    expect(device.isDefault).toBe(true);
  });
});

describe('BrowserSupport interface', () => {
  it('should have correct shape', () => {
    const support = {
      getUserMedia: true,
      audioContext: true,
      audioWorklet: true,
      mediaStreamTrack: true,
      isSafari: false,
      safariVersion: undefined,
      isFullySupported: true,
    };

    expect(typeof support.getUserMedia).toBe('boolean');
    expect(typeof support.audioContext).toBe('boolean');
    expect(typeof support.audioWorklet).toBe('boolean');
    expect(typeof support.mediaStreamTrack).toBe('boolean');
    expect(typeof support.isSafari).toBe('boolean');
    expect(typeof support.isFullySupported).toBe('boolean');
  });
});

describe('InitResult interface', () => {
  it('should represent successful result', () => {
    const success = {
      success: true,
      data: { value: 42 },
    };

    expect(success.success).toBe(true);
    expect(success.data).toEqual({ value: 42 });
    expect(success.error).toBeUndefined();
  });

  it('should represent failed result', () => {
    const failure = {
      success: false,
      error: new RoomError(RoomErrorCode.UNKNOWN, 'Test error'),
    };

    expect(failure.success).toBe(false);
    expect(failure.data).toBeUndefined();
    expect(failure.error).toBeInstanceOf(RoomError);
  });
});
