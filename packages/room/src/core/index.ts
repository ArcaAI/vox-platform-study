/**
 * @arcaai/room - Core Module
 *
 * Core classes and utilities for audio processing.
 */

export {
  AudioContextManager,
  getNewAudioContext,
  type AudioContextAcquireOptions,
  type AudioContextDiagnosticLogger,
} from './AudioContextManager.js';
export { AudioTrack, type AudioTrackOptions } from './AudioTrack.js';
export { ProcessorPipeline } from './ProcessorPipeline.js';
export { Room, RoomEvent, RoomState, createLocalTracks, type RoomEventMap } from './Room.js';
export {
  AudioMixer,
  type AudioMixerSource,
  type AudioMixerAddSourceOptions,
  type AudioMixerEventMap,
  type AudioMixerSourceLevel,
  type AudioMixerLevelMonitorOptions,
} from './AudioMixer.js';
export {
  RoomPermissionError,
  RoomDeviceError,
  RoomSecurityError,
  RoomConstraintError,
  RoomResumeTimeoutError,
  RoomSampleRateMismatchError,
  RoomUnknownError,
  RoomMediaErrorCode,
  type RoomMediaErrorCodeValue,
  mapGetUserMediaError,
} from './RoomErrors.js';
