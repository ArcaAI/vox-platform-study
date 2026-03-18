/**
 * @arcaai/stt - Utilities
 *
 * Utility functions for browser support detection and audio processing.
 */

// Browser Support
export {
  isBrowser,
  isWebAssemblySupported,
  isWebGPUSupported,
  isWebGPUAvailable,
  isAudioWorkletSupported,
  isWebSocketSupported,
  isSharedArrayBufferSupported,
  isAudioContextSupported,
  isMediaStreamTrackSupported,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  isTransformersJsSupported,
  getRecommendedDevice,
  getRecommendedProvider,
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
