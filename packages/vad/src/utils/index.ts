/**
 * @arcaai/vad - Utilities
 *
 * Utility functions and classes for VAD processing.
 */

// Browser support detection
export {
  isBrowser,
  isWebAssemblySupported,
  isAudioWorkletSupported,
  isSharedArrayBufferSupported,
  isCrossOriginIsolated,
  isAudioContextSupported,
  isMediaStreamTrackSupported,
  isScriptProcessorSupported,
  isGetUserMediaSupported,
  isSafari,
  getSafariVersion,
  isSafariAudioWorkletSupported,
  isIOS,
  isONNXRuntimeSupported,
  isVADSupported,
  getRecommendedModel,
  getFrameSamplesForModel,
  getVADBrowserSupport,
  isMultiThreadedONNXSupported,
  logVADBrowserSupport,
} from './browserSupport.js';

// Audio resampling
export {
  VAD_SAMPLE_RATE,
  linearResample,
  Resampler,
  downsampleTo16kHz,
  upsampleFrom16kHz,
} from './resampler.js';

// Frame processing
export {
  FRAME_SIZE_V5,
  FRAME_SIZE_LEGACY,
  FrameAccumulator,
  AudioRingBuffer,
  durationToSamples,
  samplesToDuration,
  durationToFrames,
  framesToDuration,
  type OnFrameReadyCallback,
} from './frameProcessor.js';
