/**
 * @arcaai/room - Utilities Module
 *
 * Utility functions for audio processing and browser support.
 */

// Browser Support
export {
  isBrowser,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  isGetUserMediaSupported,
  isAudioContextSupported,
  isAudioWorkletSupported,
  isMediaStreamTrackSupported,
  isSharedArrayBufferSupported,
  getBrowserSupport,
  isBasicAudioSupported,
  isWebAudioSupported,
  isAdvancedAudioSupported,
  getAudioContextConstructor,
} from './browserSupport.js';

// Browser Compatibility
export {
  detectBrowserName,
  detectBrowserVersion,
  meetsMinimumVersion,
  detectWasmSimd,
  getBrowserCapabilities,
  getBrowserLimitations,
} from './browserCompatibility.js';

// Constraints
export {
  buildAudioConstraints,
  getTrackFeatures,
  applyFeatureConstraint,
  isFeatureSupported,
  getSupportedFeatures,
} from './constraints.js';

// Debug Logger
export {
  debugLog,
  debugLogConfig,
  debugLogTranscript,
  type DebugTranscriptEntry,
  type DebugTranscriptWord,
} from './debugLogger.js';

// Worklet Loader
export {
  createWorkletLoader,
  type WorkletLoader,
  type WorkletLoaderOptions,
} from './workletLoader.js';

// Audio Utilities
export {
  calculateRMSLevel,
  calculatePeakLevel,
  linearToDecibels,
  decibelsToLinear,
  detectVoiceActivity,
  createSmoothingCalculator,
  createSilenceDetector,
  resampleAudio,
  audioBufferToFloat32,
  audioBufferToTrack,
  sleep,
} from './audioUtils.js';
