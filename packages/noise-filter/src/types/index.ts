/**
 * @arcaai/noise-filter - Type Definitions
 *
 * Core type definitions for the noise filter plugin.
 */

// ============================================================================
// Noise Filter Options
// ============================================================================

/**
 * Noise cancellation intensity level.
 * - 'low': Light noise reduction, preserves more natural sound
 * - 'medium': Balanced noise reduction (default)
 * - 'high': Aggressive noise reduction, best for noisy environments
 */
export type NoiseCancellationLevel = 'low' | 'medium' | 'high';

/**
 * Processing mode for performance vs quality trade-off.
 * - 'quality': Full processing, best audio quality
 * - 'performance': Optimized for lower CPU usage
 */
export type ProcessingMode = 'quality' | 'performance';

/**
 * Configuration options for the NoiseFilterProcessor.
 */
export interface NoiseFilterOptions {
  /**
   * Enable AI-powered noise cancellation using RNNoise.
   * @default true
   */
  noiseCancellation?: boolean;

  /**
   * Noise cancellation intensity level.
   * @default 'medium'
   */
  noiseCancellationLevel?: NoiseCancellationLevel;

  /**
   * Enable echo cancellation (uses WebRTC native).
   * @default true
   */
  echoCancellation?: boolean;

  /**
   * Enable automatic gain control (uses WebRTC native).
   * @default true
   */
  autoGainControl?: boolean;

  /**
   * Custom path to RNNoise WASM files.
   * If not provided, uses the bundled WASM from @jitsi/rnnoise-wasm.
   */
  wasmPath?: string;

  /**
   * Processing mode for performance vs quality trade-off.
   * @default 'quality'
   */
  processingMode?: ProcessingMode;

  /**
   * Sample rate for audio processing.
   * RNNoise is optimized for 48kHz.
   * @default 48000
   */
  sampleRate?: number;

  /**
   * Enable debug mode for verbose console logging of configuration.
   * @default false
   */
  debugMode?: boolean;

  /**
   * Enable statistics emission for monitoring.
   * @default false
   */
  enableStats?: boolean;

  /**
   * Interval for stats emission in milliseconds.
   * @default 1000
   */
  statsInterval?: number;
}

/**
 * Default options for NoiseFilterProcessor.
 *
 * TASK-304 (MED-9): frozen at module-load time so consumers cannot accidentally
 * mutate the shared defaults and break every other NoiseFilterProcessor that
 * relies on `Object.assign({}, DEFAULT_NOISE_FILTER_OPTIONS, options)` semantics.
 */
export const DEFAULT_NOISE_FILTER_OPTIONS: Readonly<Required<Omit<NoiseFilterOptions, 'wasmPath' | 'debugMode'>>> = Object.freeze({
  noiseCancellation: true,
  noiseCancellationLevel: 'medium',
  echoCancellation: true,
  autoGainControl: true,
  processingMode: 'quality',
  sampleRate: 48000,
  enableStats: false,
  statsInterval: 1000,
});

// ============================================================================
// Noise Filter Statistics
// ============================================================================

/**
 * Statistics about noise filter processing.
 */
export interface NoiseFilterStats {
  /**
   * Whether noise cancellation is currently active.
   */
  isActive: boolean;

  /**
   * Estimated noise reduction in decibels.
   */
  noiseReductionDb: number;

  /**
   * Voice Activity Detection confidence (0-1).
   * Higher values indicate higher confidence that speech is present.
   */
  vadProbability: number;

  /**
   * Processing latency in milliseconds.
   */
  latencyMs: number;

  /**
   * Number of audio frames processed.
   */
  framesProcessed: number;

  /**
   * Number of frames dropped due to processing lag.
   */
  framesDropped: number;

  /**
   * Current CPU load estimate (0-1).
   */
  cpuLoad: number;

  /**
   * Timestamp when stats were collected.
   */
  timestamp: number;
}

/**
 * Payload for noise stats data event.
 */
export interface NoiseStatsDataPayload {
  type: 'noise-stats';
  data: NoiseFilterStats;
  timestamp: number;
}

// ============================================================================
// RNNoise Types
// ============================================================================

/**
 * RNNoise processing result.
 *
 * `samples` uses `Float32Array<ArrayBufferLike>` so the same shape covers
 * both AudioWorklet inputs (`ArrayBufferLike`) and WASM-memory-backed
 * views (`ArrayBuffer`). TASK-269 — HIGH-5.
 */
export interface RNNoiseResult {
  /** Processed audio samples (same identity as the `output` argument). */
  samples: Float32Array<ArrayBufferLike>;

  /** Voice Activity Detection probability (0-1). */
  vadProbability: number;
}

/**
 * RNNoise WASM module interface.
 */
export interface RNNoiseModule {
  /**
   * Create a new denoise state.
   */
  createDenoiseState(): RNNoiseDenoiseState;
}

/**
 * RNNoise denoise state interface.
 */
export interface RNNoiseDenoiseState {
  /**
   * Process a frame of audio samples.
   * @param frame - Audio samples (480 samples at 48kHz = 10ms)
   * @returns VAD probability (0-1)
   */
  processFrame(frame: Float32Array): number;

  /**
   * Destroy the denoise state and free resources.
   */
  destroy(): void;
}

// ============================================================================
// Worklet Message Types
// ============================================================================

/**
 * Messages sent to the RNNoise AudioWorklet.
 */
export type WorkletInboundMessage =
  | { type: 'init'; wasmBinary: ArrayBuffer }
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'setLevel'; level: NoiseCancellationLevel }
  | { type: 'getStats' }
  | { type: 'destroy' };

/**
 * Messages sent from the RNNoise AudioWorklet.
 */
export type WorkletOutboundMessage =
  | { type: 'ready' }
  | { type: 'stats'; stats: NoiseFilterStats }
  | { type: 'error'; message: string }
  | { type: 'destroyed' };

// ============================================================================
// Browser Support Types
// ============================================================================

/**
 * Browser support information for noise filter features.
 */
export interface NoiseFilterBrowserSupport {
  /**
   * Whether WebAssembly is supported.
   */
  webAssembly: boolean;

  /**
   * Whether AudioWorklet is supported.
   */
  audioWorklet: boolean;

  /**
   * Whether SharedArrayBuffer is supported.
   */
  sharedArrayBuffer: boolean;

  /**
   * Whether all required features are supported for RNNoise.
   */
  rnnoiseSupported: boolean;

  /**
   * Whether WebRTC native noise suppression is supported as fallback.
   */
  nativeFallbackAvailable: boolean;

  /**
   * Reason if not supported.
   */
  unsupportedReason?: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes specific to the noise filter.
 */
export enum NoiseFilterErrorCode {
  /** WASM module failed to load */
  WASM_LOAD_FAILED = 'WASM_LOAD_FAILED',
  /** AudioWorklet registration failed */
  WORKLET_REGISTRATION_FAILED = 'WORKLET_REGISTRATION_FAILED',
  /** Processing error occurred */
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  /** Browser does not support required features */
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  /** Invalid configuration provided */
  INVALID_CONFIG = 'INVALID_CONFIG',
}

/**
 * Custom error class for noise filter errors.
 */
export class NoiseFilterError extends Error {
  constructor(
    public readonly code: NoiseFilterErrorCode,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'NoiseFilterError';
  }
}
