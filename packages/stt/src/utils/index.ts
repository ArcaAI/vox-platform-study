/**
 * @arcaai/stt - Utilities
 *
 * Utility functions for browser support detection and audio processing.
 */

// Browser Support
export {
  isBrowser,
  isAudioWorkletSupported,
  isWebSocketSupported,
  isSharedArrayBufferSupported,
  isAudioContextSupported,
  isMediaStreamTrackSupported,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  getSTTBrowserSupport,
  isSTTSupported,
  logBrowserSupport,
} from './browserSupport.js';

// Audio Resampling
export {
  WHISPER_SAMPLE_RATE,
  resampleLinear,
  stereoToMono,
  multiChannelToMono,
  prepareAudioForWhisper,
  prepareFloat32ForWhisper,
  // TASK-985 M-53 — stateful, rate-exact streaming converter (keeps kernel history across frames).
  createStreamingResampler,
  type StreamingResampler,
  int16ToFloat32,
  float32ToInt16,
  bytesToFloat32,
  float32ToBytes,
  samplesToDuration,
  durationToSamples,
  normalizeAudio,
  concatenateFloat32Arrays,
  type NormalizeOptions,
} from './audioResampler.js';
