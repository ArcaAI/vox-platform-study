/**
 * @arcaai/room - MediaStream Constraints Utilities
 *
 * Utilities for building and managing MediaTrackConstraints.
 */

import { AudioFeature, DEFAULT_AUDIO_OPTIONS, type AudioCaptureOptions } from '../types/index.js';

/**
 * Build MediaTrackConstraints from AudioCaptureOptions.
 *
 * @param options - The audio capture options
 * @returns MediaTrackConstraints for getUserMedia
 */
export function buildAudioConstraints(options: AudioCaptureOptions = {}): MediaTrackConstraints {
  const merged = { ...DEFAULT_AUDIO_OPTIONS, ...options };

  const constraints: MediaTrackConstraints = {
    echoCancellation: merged.echoCancellation,
    noiseSuppression: merged.noiseSuppression,
    autoGainControl: merged.autoGainControl,
    channelCount: merged.channelCount,
  };

  // Add device ID if specified
  if (options.deviceId) {
    constraints.deviceId = { exact: options.deviceId };
  }

  // Add sample rate if specified
  if (options.sampleRate) {
    constraints.sampleRate = options.sampleRate;
  }

  // Add latency if specified (experimental feature)
  if (options.latency) {
    (constraints as MediaTrackConstraints & { latency?: number }).latency = options.latency;
  }

  // Add voice isolation if specified (experimental feature)
  if (merged.voiceIsolation !== undefined) {
    (constraints as MediaTrackConstraints & { voiceIsolation?: boolean }).voiceIsolation = merged.voiceIsolation;
  }

  return constraints;
}

/**
 * Extract current feature settings from MediaStreamTrack.
 *
 * @param track - The MediaStreamTrack to inspect
 * @returns Map of audio features and their enabled state
 */
export function getTrackFeatures(track: MediaStreamTrack): Map<AudioFeature, boolean> {
  const settings = track.getSettings();
  const features = new Map<AudioFeature, boolean>();

  // Check each feature from track settings
  features.set(AudioFeature.AUTO_GAIN_CONTROL, settings.autoGainControl ?? false);
  // TS 6 ships the newer DOM lib, where `echoCancellation` is `boolean | string`:
  // the spec grew echo-cancellation MODES ("all", "remote-only") beyond the original
  // on/off. This map is a feature-ENABLED map, and any mode means enabled, so coerce
  // rather than narrow — `?? false` alone no longer types as boolean.
  features.set(AudioFeature.ECHO_CANCELLATION, Boolean(settings.echoCancellation ?? false));
  features.set(AudioFeature.NOISE_SUPPRESSION, settings.noiseSuppression ?? false);

  // Voice isolation is experimental
  const extendedSettings = settings as MediaTrackSettings & {
    voiceIsolation?: boolean;
  };
  features.set(AudioFeature.VOICE_ISOLATION, extendedSettings.voiceIsolation ?? false);

  return features;
}

/**
 * Apply a feature constraint to a MediaStreamTrack.
 *
 * @param track - The track to apply constraints to
 * @param feature - The feature to enable/disable
 * @param enabled - Whether to enable or disable the feature
 */
export async function applyFeatureConstraint(track: MediaStreamTrack, feature: AudioFeature, enabled: boolean): Promise<void> {
  const currentSettings = track.getSettings();

  const constraints: MediaTrackConstraints = {
    ...currentSettings,
    [feature]: enabled,
  };

  await track.applyConstraints(constraints);
}

/**
 * Check if a feature is supported by the current browser/device.
 *
 * @param feature - The feature to check
 * @returns Whether the feature is supported
 */
export function isFeatureSupported(feature: AudioFeature): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return false;
  }

  // Get supported constraints
  const supportedConstraints = navigator.mediaDevices.getSupportedConstraints();

  switch (feature) {
    case AudioFeature.AUTO_GAIN_CONTROL:
      return supportedConstraints.autoGainControl ?? false;
    case AudioFeature.ECHO_CANCELLATION:
      return supportedConstraints.echoCancellation ?? false;
    case AudioFeature.NOISE_SUPPRESSION:
      return supportedConstraints.noiseSuppression ?? false;
    case AudioFeature.VOICE_ISOLATION:
      // Voice isolation is experimental and may not be in the standard type
      return (
        (
          supportedConstraints as MediaTrackSupportedConstraints & {
            voiceIsolation?: boolean;
          }
        ).voiceIsolation ?? false
      );
    default:
      return false;
  }
}

/**
 * Get all supported audio features.
 *
 * @returns Array of supported features
 */
export function getSupportedFeatures(): AudioFeature[] {
  return Object.values(AudioFeature).filter(isFeatureSupported);
}
