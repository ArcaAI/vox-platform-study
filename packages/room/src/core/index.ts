/**
 * @arcaai/room - Core Module
 *
 * Core classes and utilities for audio processing.
 */

export { AudioContextManager, getNewAudioContext } from './AudioContextManager.js';
export { AudioTrack, type AudioTrackOptions } from './AudioTrack.js';
export { ProcessorPipeline } from './ProcessorPipeline.js';
export {
  Room,
  RoomEvent,
  RoomState,
  createLocalTracks,
  type RoomEventMap,
} from './Room.js';
export { AudioMixer, type AudioMixerSource, type AudioMixerEventMap } from './AudioMixer.js';
