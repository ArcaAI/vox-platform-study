/**
 * @arcaai/noise-filter
 *
 * AI-powered noise cancellation plugin for @arcaai/room.
 * Uses RNNoise (Mozilla's open-source deep learning noise suppression)
 * via WebAssembly for high-quality noise cancellation.
 *
 * @example
 * ```typescript
 * import { NoiseFilterProcessor, createNoiseFilter } from '@arcaai/noise-filter';
 * import { useAudioTrack, useProcessors } from '@arcaai/room';
 *
 * function AudioRecorder() {
 *   const { track, startCapture } = useAudioTrack({
 *     noiseSuppression: false,  // Disable native NS, we use RNNoise
 *     echoCancellation: true,
 *   });
 *
 *   const { addProcessor } = useProcessors({ track });
 *
 *   useEffect(() => {
 *     if (track) {
 *       const noiseFilter = createNoiseFilter({
 *         noiseCancellation: true,
 *         noiseCancellationLevel: 'high',
 *       });
 *       addProcessor(noiseFilter);
 *     }
 *   }, [track]);
 *
 *   return <button onClick={startCapture}>Start</button>;
 * }
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

export {
  // Options
  type NoiseFilterOptions,
  type NoiseCancellationLevel,
  type ProcessingMode,
  DEFAULT_NOISE_FILTER_OPTIONS,

  // Statistics
  type NoiseFilterStats,
  type NoiseStatsDataPayload,

  // RNNoise Types
  type RNNoiseResult,
  type RNNoiseModule,
  type RNNoiseDenoiseState,

  // Worklet Messages
  type WorkletInboundMessage,
  type WorkletOutboundMessage,

  // Browser Support
  type NoiseFilterBrowserSupport,

  // Errors
  NoiseFilterErrorCode,
  NoiseFilterError,
} from './types/index.js';

// ============================================================================
// Processors
// ============================================================================

export {
  // Main Processor
  NoiseFilterProcessor,
  createNoiseFilter,

  // Low-level RNNoise Processor
  RNNoiseProcessor,
  RNNOISE_FRAME_SIZE,
  RNNOISE_SAMPLE_RATE,
} from './processors/index.js';

// ============================================================================
// React Hooks
// ============================================================================

export {
  useNoiseFilter,
  type UseNoiseFilterOptions,
  type UseNoiseFilterReturn,
} from './hooks/index.js';

// ============================================================================
// Worklets
// ============================================================================

export {
  WORKLET_PROCESSOR_NAME,
  registerRNNoiseWorklet,
  isWorkletRegistered,
  createRNNoiseWorkletNode,
  cleanupWorkletResources,
} from './worklets/index.js';

// ============================================================================
// Utilities
// ============================================================================

export {
  // Browser Detection
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
} from './utils/index.js';
