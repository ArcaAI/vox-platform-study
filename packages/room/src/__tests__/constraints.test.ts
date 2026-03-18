/**
 * @arcaai/room - Constraints Utilities Tests
 *
 * Comprehensive tests for MediaStream constraints utilities.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAudioConstraints,
  getTrackFeatures,
  applyFeatureConstraint,
  isFeatureSupported,
  getSupportedFeatures,
} from '../utils/constraints.js';
import { AudioFeature, DEFAULT_AUDIO_OPTIONS } from '../types/index.js';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockTrack(settings: Partial<MediaTrackSettings> = {}): MediaStreamTrack {
  const defaultSettings: MediaTrackSettings = {
    deviceId: 'mock-device-id',
    groupId: 'mock-group-id',
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
    channelCount: 1,
    sampleRate: 48000,
    ...settings,
  };

  return {
    kind: 'audio',
    id: 'mock-track-id',
    enabled: true,
    muted: false,
    readyState: 'live',
    label: 'Mock Audio Track',
    stop: vi.fn(),
    clone: vi.fn(),
    getSettings: vi.fn().mockReturnValue(defaultSettings),
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

// ============================================================================
// Tests
// ============================================================================

describe('buildAudioConstraints', () => {
  it('should return default constraints when no options provided', () => {
    const constraints = buildAudioConstraints();

    expect(constraints.echoCancellation).toBe(DEFAULT_AUDIO_OPTIONS.echoCancellation);
    expect(constraints.noiseSuppression).toBe(DEFAULT_AUDIO_OPTIONS.noiseSuppression);
    expect(constraints.autoGainControl).toBe(DEFAULT_AUDIO_OPTIONS.autoGainControl);
    expect(constraints.channelCount).toBe(DEFAULT_AUDIO_OPTIONS.channelCount);
  });

  it('should override defaults with provided options', () => {
    const constraints = buildAudioConstraints({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    });

    expect(constraints.echoCancellation).toBe(false);
    expect(constraints.noiseSuppression).toBe(false);
    expect(constraints.autoGainControl).toBe(false);
    expect(constraints.channelCount).toBe(2);
  });

  it('should add deviceId when specified', () => {
    const constraints = buildAudioConstraints({
      deviceId: 'my-device-id',
    });

    expect(constraints.deviceId).toEqual({ exact: 'my-device-id' });
  });

  it('should add sampleRate when specified', () => {
    const constraints = buildAudioConstraints({
      sampleRate: 16000,
    });

    expect(constraints.sampleRate).toBe(16000);
  });

  it('should add latency when specified', () => {
    const constraints = buildAudioConstraints({
      latency: 0.01,
    });

    expect((constraints as MediaTrackConstraints & { latency?: number }).latency).toBe(0.01);
  });

  it('should add voiceIsolation when specified', () => {
    const constraints = buildAudioConstraints({
      voiceIsolation: true,
    });

    expect(
      (constraints as MediaTrackConstraints & { voiceIsolation?: boolean }).voiceIsolation
    ).toBe(true);
  });

  it('should merge partial options with defaults', () => {
    const constraints = buildAudioConstraints({
      echoCancellation: false,
    });

    expect(constraints.echoCancellation).toBe(false);
    expect(constraints.noiseSuppression).toBe(true); // default
    expect(constraints.autoGainControl).toBe(true); // default
  });
});

describe('getTrackFeatures', () => {
  it('should return feature map from track settings', () => {
    const track = createMockTrack({
      autoGainControl: true,
      echoCancellation: false,
      noiseSuppression: true,
    });

    const features = getTrackFeatures(track);

    expect(features.get(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);
    expect(features.get(AudioFeature.ECHO_CANCELLATION)).toBe(false);
    expect(features.get(AudioFeature.NOISE_SUPPRESSION)).toBe(true);
  });

  it('should return false for undefined settings', () => {
    const track = createMockTrack({});
    // Override to return settings without audio features
    (track.getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      deviceId: 'test',
    });

    const features = getTrackFeatures(track);

    expect(features.get(AudioFeature.AUTO_GAIN_CONTROL)).toBe(false);
    expect(features.get(AudioFeature.ECHO_CANCELLATION)).toBe(false);
    expect(features.get(AudioFeature.NOISE_SUPPRESSION)).toBe(false);
  });

  it('should include voice isolation feature', () => {
    const track = createMockTrack();
    (track.getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
    });

    const features = getTrackFeatures(track);

    expect(features.get(AudioFeature.VOICE_ISOLATION)).toBe(true);
  });

  it('should return Map with all AudioFeature keys', () => {
    const track = createMockTrack();
    const features = getTrackFeatures(track);

    expect(features.has(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);
    expect(features.has(AudioFeature.ECHO_CANCELLATION)).toBe(true);
    expect(features.has(AudioFeature.NOISE_SUPPRESSION)).toBe(true);
    expect(features.has(AudioFeature.VOICE_ISOLATION)).toBe(true);
  });
});

describe('applyFeatureConstraint', () => {
  let track: MediaStreamTrack;

  beforeEach(() => {
    track = createMockTrack({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('should apply echoCancellation constraint', async () => {
    await applyFeatureConstraint(track, AudioFeature.ECHO_CANCELLATION, true);

    expect(track.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        echoCancellation: true,
      })
    );
  });

  it('should apply noiseSuppression constraint', async () => {
    await applyFeatureConstraint(track, AudioFeature.NOISE_SUPPRESSION, true);

    expect(track.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        noiseSuppression: true,
      })
    );
  });

  it('should apply autoGainControl constraint', async () => {
    await applyFeatureConstraint(track, AudioFeature.AUTO_GAIN_CONTROL, true);

    expect(track.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        autoGainControl: true,
      })
    );
  });

  it('should apply voiceIsolation constraint', async () => {
    await applyFeatureConstraint(track, AudioFeature.VOICE_ISOLATION, true);

    expect(track.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceIsolation: true,
      })
    );
  });

  it('should disable feature when enabled is false', async () => {
    await applyFeatureConstraint(track, AudioFeature.ECHO_CANCELLATION, false);

    expect(track.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        echoCancellation: false,
      })
    );
  });

  it('should preserve existing settings', async () => {
    (track.getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      deviceId: 'my-device',
      sampleRate: 48000,
      echoCancellation: false,
    });

    await applyFeatureConstraint(track, AudioFeature.ECHO_CANCELLATION, true);

    expect(track.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'my-device',
        sampleRate: 48000,
        echoCancellation: true,
      })
    );
  });
});

describe('isFeatureSupported', () => {
  const originalNavigator = global.navigator;

  afterEach(() => {
    // Restore original navigator
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
    });
  });

  it('should return false when navigator is undefined', () => {
    Object.defineProperty(global, 'navigator', {
      value: undefined,
      writable: true,
    });

    expect(isFeatureSupported(AudioFeature.ECHO_CANCELLATION)).toBe(false);
  });

  it('should return false when mediaDevices is undefined', () => {
    Object.defineProperty(global, 'navigator', {
      value: {},
      writable: true,
    });

    expect(isFeatureSupported(AudioFeature.ECHO_CANCELLATION)).toBe(false);
  });

  it('should check echoCancellation support', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({
            echoCancellation: true,
          }),
        },
      },
      writable: true,
    });

    expect(isFeatureSupported(AudioFeature.ECHO_CANCELLATION)).toBe(true);
  });

  it('should check noiseSuppression support', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({
            noiseSuppression: true,
          }),
        },
      },
      writable: true,
    });

    expect(isFeatureSupported(AudioFeature.NOISE_SUPPRESSION)).toBe(true);
  });

  it('should check autoGainControl support', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({
            autoGainControl: true,
          }),
        },
      },
      writable: true,
    });

    expect(isFeatureSupported(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);
  });

  it('should check voiceIsolation support', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({
            voiceIsolation: true,
          }),
        },
      },
      writable: true,
    });

    expect(isFeatureSupported(AudioFeature.VOICE_ISOLATION)).toBe(true);
  });

  it('should return false for unsupported feature', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({
            echoCancellation: false,
          }),
        },
      },
      writable: true,
    });

    expect(isFeatureSupported(AudioFeature.ECHO_CANCELLATION)).toBe(false);
  });

  it('should return false for unknown feature', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({}),
        },
      },
      writable: true,
    });

    expect(isFeatureSupported('unknownFeature' as AudioFeature)).toBe(false);
  });
});

describe('getSupportedFeatures', () => {
  const originalNavigator = global.navigator;

  afterEach(() => {
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
    });
  });

  it('should return array of supported features', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            voiceIsolation: false,
          }),
        },
      },
      writable: true,
    });

    const supported = getSupportedFeatures();

    expect(supported).toContain(AudioFeature.ECHO_CANCELLATION);
    expect(supported).toContain(AudioFeature.NOISE_SUPPRESSION);
    expect(supported).toContain(AudioFeature.AUTO_GAIN_CONTROL);
    expect(supported).not.toContain(AudioFeature.VOICE_ISOLATION);
  });

  it('should return empty array when no features supported', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getSupportedConstraints: () => ({}),
        },
      },
      writable: true,
    });

    const supported = getSupportedFeatures();

    expect(supported).toHaveLength(0);
  });

  it('should return empty array when navigator is undefined', () => {
    Object.defineProperty(global, 'navigator', {
      value: undefined,
      writable: true,
    });

    const supported = getSupportedFeatures();

    expect(supported).toHaveLength(0);
  });
});
