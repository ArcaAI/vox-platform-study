/**
 * @arcaai/room - Events Module
 *
 * Event definitions and typed event emitter.
 */

// Track Events
export {
  TrackEvent,
  type TrackEventMap,
  type TrackEventPayload,
  type ProcessorUpdatePayload,
  type FeatureUpdatePayload,
  type TrackErrorPayload,
} from './TrackEvents.js';

// Processor Events
export {
  ProcessorEvent,
  type ProcessorEventMap,
  type ProcessorEventPayload,
  type ProcessorErrorPayload,
  type ProcessorDataPayload,
  type VADDataPayload,
  type TranscriptionDataPayload,
  type SpeakerRecognitionDataPayload,
} from './ProcessorEvents.js';

// Event Emitter
export { TypedEventEmitter, type EventMap, type EventHandler } from './EventEmitter.js';
