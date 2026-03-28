/**
 * @arcaai/vad
 *
 * Voice Activity Detection plugin for @arcaai/room using Silero VAD v5.
 * Provides accurate, real-time speech detection with configurable thresholds.
 *
 * @example
 * ```tsx
 * import { useAudioTrack } from '@arcaai/room';
 * import { useVAD } from '@arcaai/vad';
 *
 * function VoiceRecorder() {
 *   const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
 *     noiseSuppression: true,
 *   });
 *
 *   const { isSpeaking, speechProbability } = useVAD({
 *     track,
 *     model: 'v5',
 *     onSpeechEnd: (audio) => {
 *       // Send to transcription service
 *       console.log('Got speech segment:', audio.length, 'samples');
 *     },
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={isCapturing ? stopCapture : startCapture}>
 *         {isCapturing ? 'Stop' : 'Start'}
 *       </button>
 *       <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
 *       <div>Probability: {(speechProbability * 100).toFixed(1)}%</div>
 *     </div>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

export {
  // Model Types
  type VADModel,

  // Options
  type VADOptions,
  type VADOptionsWithCallbacks,
  DEFAULT_VAD_OPTIONS,

  // Statistics
  type VADStats,

  // Event Payloads
  type VADFramePayload,
  type VADSpeechStartPayload,
  type VADSpeechRealStartPayload,
  type VADSpeechEndPayload,
  type VADMisfirePayload,
  type VADStatsPayload,
  type VADDataEventType,

  // Worklet Messages
  type VADWorkletInboundMessage,
  type VADWorkletOutboundMessage,
  type VADWorkletConfig,

  // Browser Support
  type VADBrowserSupport,

  // Errors
  VADErrorCode,
  VADError,

  // Callbacks
  type OnSpeechStartCallback,
  type OnSpeechRealStartCallback,
  type OnSpeechEndCallback,
  type OnVADMisfireCallback,
  type OnFrameProcessedCallback,
} from './types/index.js';

// ============================================================================
// Processors
// ============================================================================

export { VADProcessor, createVAD } from './processors/index.js';

// ============================================================================
// React Hooks
// ============================================================================

export { useVAD, type UseVADOptions, type UseVADReturn } from './hooks/index.js';

// ============================================================================
// Utilities
// ============================================================================

export {
  // Browser Support
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

  // Audio Resampling
  VAD_SAMPLE_RATE,
  linearResample,
  Resampler,
  downsampleTo16kHz,
  upsampleFrom16kHz,

  // Frame Processing
  FRAME_SIZE_V5,
  FRAME_SIZE_LEGACY,
  FrameAccumulator,
  AudioRingBuffer,
  durationToSamples,
  samplesToDuration,
  durationToFrames,
  framesToDuration,
  type OnFrameReadyCallback,
} from './utils/index.js';

// ============================================================================
// Worklets (public subset — registration/cleanup are internal)
// ============================================================================

export { WORKLET_PROCESSOR_NAME, isVADWorkletRegistered } from './worklets/index.js';
