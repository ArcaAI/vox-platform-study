/**
 * @arcaai/room - Processor Events
 *
 * Event definitions for track processors.
 */

// ============================================================================
// Processor Event Types
// ============================================================================

/**
 * Events emitted by TrackProcessor implementations.
 */
export enum ProcessorEvent {
  /** Processor has been initialized and is ready */
  Ready = 'ready',
  /** Processor has been enabled */
  Enabled = 'enabled',
  /** Processor has been disabled */
  Disabled = 'disabled',
  /** Processor has been destroyed */
  Destroyed = 'destroyed',
  /** Processor encountered an error */
  Error = 'error',
  /** Processor-specific data event (e.g., VAD result, transcription) */
  Data = 'data',
}

// ============================================================================
// Processor Event Payloads
// ============================================================================

/**
 * Payload for processor Error event.
 */
export interface ProcessorErrorPayload {
  /** Error that occurred */
  error: Error;
  /** Whether the processor can recover from this error */
  recoverable: boolean;
}

/**
 * Payload for processor Data event.
 * This is a generic payload - specific processors can extend this.
 */
export interface ProcessorDataPayload<T = unknown> {
  /** Type of data being emitted */
  type: string;
  /** The actual data */
  data: T;
  /** Timestamp when the data was generated */
  timestamp: number;
}

// ============================================================================
// Processor Event Map
// ============================================================================

/**
 * Type-safe event map for Processor events.
 */
export interface ProcessorEventMap {
  [ProcessorEvent.Ready]: void;
  [ProcessorEvent.Enabled]: void;
  [ProcessorEvent.Disabled]: void;
  [ProcessorEvent.Destroyed]: void;
  [ProcessorEvent.Error]: ProcessorErrorPayload;
  [ProcessorEvent.Data]: ProcessorDataPayload;
}

/**
 * Helper type to get the payload type for a specific processor event.
 */
export type ProcessorEventPayload<E extends ProcessorEvent> = ProcessorEventMap[E];

// ============================================================================
// Common Processor Data Types
// ============================================================================

/**
 * VAD (Voice Activity Detection) data payload.
 */
export interface VADDataPayload {
  /** Whether voice activity is detected */
  isSpeaking: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Duration of current speech segment in ms */
  speechDuration?: number;
}

/**
 * Transcription data payload.
 */
export interface TranscriptionDataPayload {
  /** Transcribed text */
  text: string;
  /** Whether this is a final transcription or interim */
  isFinal: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Start time of the segment */
  startTime: number;
  /** End time of the segment */
  endTime: number;
  /** Language detected */
  language?: string;
}

/**
 * Speaker recognition data payload.
 */
export interface SpeakerRecognitionDataPayload {
  /** Identified speaker ID */
  speakerId: string;
  /** Speaker label/name if known */
  speakerLabel?: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Voice embedding for the segment */
  embedding?: Float32Array;
}
