/**
 * @arcaai/noise-filter - Utils Module
 *
 * Utility functions for the noise filter package.
 */

export {
  isBrowser,
  isWebAssemblySupported,
  isAudioWorkletSupported,
  isSharedArrayBufferSupported,
  isAudioContextSupported,
  isMediaStreamTrackSupported,
  isScriptProcessorSupported,
  isNativeNoiseSuppressionSupported,
  isSafari,
  getSafariVersion,
  isSafariAudioWorkletSupported,
  isRNNoiseSupported,
  getNoiseFilterBrowserSupport,
  getRecommendedProcessingMode,
  logBrowserSupport,
} from './browserSupport.js';
