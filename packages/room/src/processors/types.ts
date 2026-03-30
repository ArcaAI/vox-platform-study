/**
 * @arcaai/room - Processor Types
 *
 * Type definitions for the TrackProcessor interface and related types.
 * This is the plugin contract that all audio processors must implement.
 */

import type { TypedEventEmitter } from '../events/EventEmitter.js';
import type { ProcessorEventMap } from '../events/ProcessorEvents.js';

// ============================================================================
// Processor Options
// ============================================================================

/**
 * Base options passed to a processor during initialization.
 */
export interface ProcessorOptions {
  /** The source MediaStreamTrack to process */
  track: MediaStreamTrack;
  /** The AudioContext to use for Web Audio processing */
  audioContext: AudioContext;
  /** Optional HTML media element for playback */
  element?: HTMLMediaElement;
}

/**
 * Audio-specific processor options.
 */
export interface AudioProcessorOptions extends ProcessorOptions {
  /** The kind of track - always 'audio' for audio processors */
  kind: 'audio';
}

// ============================================================================
// TrackProcessor Interface
// ============================================================================

/**
 * Interface that all audio processors must implement.
 *
 * This is the plugin contract for the @arcaai/room package.
 * Processors can be used for VAD, transcription, noise cancellation,
 * speaker recognition, and other audio processing tasks.
 *
 * @example
 * ```typescript
 * class MyProcessor implements TrackProcessor {
 *   name = 'my-processor';
 *   processedTrack?: MediaStreamTrack;
 *
 *   async init(opts: AudioProcessorOptions): Promise<void> {
 *     // Set up audio processing
 *     // Create this.processedTrack
 *   }
 *
 *   async restart(opts: AudioProcessorOptions): Promise<void> {
 *     await this.destroy();
 *     await this.init(opts);
 *   }
 *
 *   async destroy(): Promise<void> {
 *     this.processedTrack?.stop();
 *     this.processedTrack = undefined;
 *   }
 * }
 * ```
 */
export interface TrackProcessor<TOptions extends ProcessorOptions = AudioProcessorOptions> {
  /**
   * Unique name identifier for this processor.
   * Used for logging and debugging.
   */
  readonly name: string;

  /**
   * The processed output track.
   * This track should be set during init() and will be used
   * instead of the source track for downstream processing.
   */
  processedTrack?: MediaStreamTrack | undefined;

  /**
   * Initialize the processor with the given options.
   * This should set up the audio processing pipeline and
   * create the processedTrack.
   *
   * @param opts - The options for initialization
   */
  init(opts: TOptions): Promise<void>;

  /**
   * Restart the processor with new options.
   * This is called when the source track changes (e.g., device switch).
   *
   * @param opts - The new options
   */
  restart(opts: TOptions): Promise<void>;

  /**
   * Destroy the processor and release all resources.
   * This should stop the processedTrack and clean up any
   * audio nodes or workers.
   */
  destroy(): Promise<void>;

  /**
   * Optional: Called when the track is attached to an AudioTrack.
   * Useful for processors that need to know about the parent track.
   */
  onAttach?(): Promise<void>;

  /**
   * Optional: Called when the track is detached from an AudioTrack.
   */
  onDetach?(): Promise<void>;

  /**
   * Optional: Enable the processor.
   * Some processors support being enabled/disabled without full restart.
   */
  enable?(): Promise<void>;

  /**
   * Optional: Disable the processor.
   */
  disable?(): Promise<void>;

  /**
   * Optional: Check if the processor is enabled.
   */
  isEnabled?(): boolean;

  /**
   * Optional: Check if this processor is supported in the current browser.
   */
  isSupported?(): boolean;
}

/**
 * Interface for processors that emit events.
 * Extends TrackProcessor with event emission capabilities.
 */
export interface EventEmittingProcessor<TOptions extends ProcessorOptions = AudioProcessorOptions>
  extends TrackProcessor<TOptions>, TypedEventEmitter<ProcessorEventMap> {}

// ============================================================================
// Processor Factory Types
// ============================================================================

/**
 * Factory function type for creating processors.
 */
export type ProcessorFactory<TConfig = unknown, TOptions extends ProcessorOptions = AudioProcessorOptions> = (
  config?: TConfig,
) => TrackProcessor<TOptions>;

/**
 * Configuration for a processor in the pipeline.
 */
export interface ProcessorConfig {
  /** The processor instance */
  processor: TrackProcessor;
  /** Whether the processor is enabled */
  enabled: boolean;
  /** Priority for ordering (lower = earlier in pipeline) */
  priority: number;
}

// ============================================================================
// Shared Processor Statistics
// ============================================================================

/**
 * Base statistics interface that all processor stats should extend.
 * Provides a common set of properties for monitoring processor performance.
 */
export interface BaseProcessorStats {
  /** Whether the processor is currently active and processing */
  isActive: boolean;

  /** Number of frames/items processed */
  framesProcessed: number;

  /** Total processing time in milliseconds */
  processingTimeMs: number;

  /** Timestamp when stats were collected */
  timestamp: number;
}

/**
 * Statistics interface for audio processors.
 * Extends base stats with audio-specific metrics.
 */
export interface AudioProcessorStats extends BaseProcessorStats {
  /** Processing latency in milliseconds */
  latencyMs: number;

  /** Estimated CPU load (0-1) */
  cpuLoad?: number;

  /** Number of frames dropped due to processing lag */
  droppedFrames?: number;

  /** Sample rate of the audio being processed */
  sampleRate?: number;
}

/**
 * Statistics interface for text processors.
 * Extends base stats with text-specific metrics.
 */
export interface TextProcessorStats extends BaseProcessorStats {
  /** Number of tokens/characters processed */
  tokensProcessed: number;

  /** Average processing latency in milliseconds */
  averageLatencyMs: number;

  /** Number of items in the processing queue */
  queueSize?: number;
}

// ============================================================================
// Processor Status Types
// ============================================================================

/**
 * Status of a processor.
 */
export enum ProcessorStatus {
  /** Processor is not initialized */
  IDLE = 'idle',
  /** Processor is initializing */
  INITIALIZING = 'initializing',
  /** Processor is ready and active */
  READY = 'ready',
  /** Processor is enabled and processing */
  ENABLED = 'enabled',
  /** Processor is disabled (but still initialized) */
  DISABLED = 'disabled',
  /** Processor has encountered an error */
  ERROR = 'error',
  /** Processor has been destroyed */
  DESTROYED = 'destroyed',
}

/**
 * Information about a processor's current state.
 */
export interface ProcessorInfo {
  /** Processor name */
  name: string;
  /** Current status */
  status: ProcessorStatus;
  /** Whether the processor has a processed track */
  hasProcessedTrack: boolean;
  /** Error message if status is ERROR */
  errorMessage?: string;
}
