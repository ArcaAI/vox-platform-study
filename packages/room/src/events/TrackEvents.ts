/**
 * @arcaai/room - Track Events
 *
 * Event definitions for audio track lifecycle and state changes.
 */

import type { AudioFeature, AudioLevelInfo } from '../types/index.js';
import type { TrackProcessor } from '../processors/types.js';

// ============================================================================
// Track Event Types
// ============================================================================

/**
 * Events emitted by AudioTrack.
 */
export enum TrackEvent {
  /** Track has been muted */
  Muted = 'muted',
  /** Track has been unmuted */
  Unmuted = 'unmuted',
  /** Track has ended (stopped) */
  Ended = 'ended',
  /** Track has been restarted */
  Restarted = 'restarted',
  /** Processor has been added, removed, or changed */
  ProcessorUpdate = 'processorUpdate',
  /** Audio feature has been enabled or disabled */
  FeatureUpdate = 'featureUpdate',
  /** Audio level has changed */
  AudioLevelUpdate = 'audioLevelUpdate',
  /** Silence has been detected */
  SilenceDetected = 'silenceDetected',
  /** Track encountered an error */
  Error = 'error',
}

// ============================================================================
// Track Event Payloads
// ============================================================================

/**
 * Payload for ProcessorUpdate event.
 */
export interface ProcessorUpdatePayload {
  /** The processor that was set, or undefined if removed */
  processor: TrackProcessor | undefined;
  /** Previous processor, if any */
  previousProcessor: TrackProcessor | undefined;
}

/**
 * Payload for FeatureUpdate event.
 */
export interface FeatureUpdatePayload {
  /** The feature that was updated */
  feature: AudioFeature;
  /** Whether the feature is now enabled */
  enabled: boolean;
}

/**
 * Payload for Error event.
 */
export interface TrackErrorPayload {
  /** Error that occurred */
  error: Error;
  /** Context where the error occurred */
  context: string;
}

// ============================================================================
// Track Event Map
// ============================================================================

/**
 * Type-safe event map for AudioTrack events.
 */
export interface TrackEventMap {
  [TrackEvent.Muted]: void;
  [TrackEvent.Unmuted]: void;
  [TrackEvent.Ended]: void;
  [TrackEvent.Restarted]: void;
  [TrackEvent.ProcessorUpdate]: ProcessorUpdatePayload;
  [TrackEvent.FeatureUpdate]: FeatureUpdatePayload;
  [TrackEvent.AudioLevelUpdate]: AudioLevelInfo;
  [TrackEvent.SilenceDetected]: void;
  [TrackEvent.Error]: TrackErrorPayload;
}

/**
 * Helper type to get the payload type for a specific event.
 */
export type TrackEventPayload<E extends TrackEvent> = TrackEventMap[E];
