/**
 * @arcaai/vad - VADProcessor
 *
 * Main Voice Activity Detection processor that extends BaseProcessor from @arcaai/room.
 * Uses Silero VAD v5 via @ricky0123/vad-web for accurate speech detection.
 */

import {
  BaseProcessor,
  type AudioProcessorOptions,
  ProcessorEvent,
  debugLogConfig,
} from '@arcaai/room';

import { MicVAD, type RealTimeVADOptions } from '@ricky0123/vad-web';

import {
  type VADOptions,
  type VADOptionsWithCallbacks,
  type VADStats,
  type VADModel,
  type VADFramePayload,
  type VADSpeechStartPayload,
  type VADSpeechRealStartPayload,
  type VADSpeechEndPayload,
  type VADMisfirePayload,
  DEFAULT_VAD_OPTIONS,
  VADError,
  VADErrorCode,
} from '../types/index.js';

import {
  getVADBrowserSupport,
  isVADSupported,
} from '../utils/browserSupport.js';

/**
 * Default CDN paths for VAD assets.
 */
const DEFAULT_BASE_ASSET_PATH =
  'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/';
const DEFAULT_ONNX_WASM_BASE_PATH =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

/**
 * VADProcessor provides Voice Activity Detection for audio tracks.
 *
 * Features:
 * - Silero VAD v5 model for accurate speech detection
 * - Real-time processing via AudioWorklet
 * - Configurable thresholds and timing parameters
 * - Speech segment extraction with audio data
 * - Statistics emission for monitoring
 *
 * @example
 * ```typescript
 * import { VADProcessor } from '@arcaai/vad';
 *
 * const vad = new VADProcessor({
 *   model: 'v5',
 *   positiveSpeechThreshold: 0.5,
 *   minSpeechMs: 250,
 * });
 *
 * // Attach to an AudioTrack
 * await audioTrack.setProcessor(vad);
 *
 * // Listen for speech events
 * vad.on('data', (payload) => {
 *   if (payload.type === 'vad-speech-end') {
 *     console.log('Speech segment:', payload.data.audio);
 *     // Send to transcription service
 *   }
 * });
 *
 * // Cleanup
 * await vad.destroy();
 * ```
 */
export class VADProcessor extends BaseProcessor {
  private options: Required<
    Omit<VADOptions, 'baseAssetPath' | 'onnxWASMBasePath' | 'additionalAudioConstraints' | 'debugMode'>
  > & {
    baseAssetPath?: string;
    onnxWASMBasePath?: string;
    additionalAudioConstraints?: Partial<MediaTrackConstraints>;
  };

  // VAD engine from @ricky0123/vad-web
  private micVAD: MicVAD | null = null;

  // Audio processing nodes
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  // Callbacks (optional direct callbacks in addition to events)
  private callbacks: {
    onSpeechStart?: () => void;
    onSpeechRealStart?: () => void;
    onSpeechEnd?: (audio: Float32Array) => void;
    onVADMisfire?: () => void;
    onFrameProcessed?: (
      probabilities: { isSpeech: number; notSpeech: number },
      frame: Float32Array
    ) => void;
  } = {};

  // Statistics
  private stats: VADStats = {
    isActive: false,
    isSpeaking: false,
    speechProbability: 0,
    currentSpeechDuration: 0,
    framesProcessed: 0,
    speechSegmentsDetected: 0,
    misfireCount: 0,
    averageSpeechProbability: 0,
    timestamp: Date.now(),
  };

  // Stats interval
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  // Speech tracking
  private speechStartTime = 0;
  private probabilitySum = 0;
  private probabilityCount = 0;

  // Stream-relative timing: wall-clock timestamp when the audio stream started
  private streamStartWallClock = 0;

  constructor(options: VADOptionsWithCallbacks = {}) {
    super('vad-processor', options.debugMode);

    // Extract callbacks
    this.callbacks = {
      onSpeechStart: options.onSpeechStart,
      onSpeechRealStart: options.onSpeechRealStart,
      onSpeechEnd: options.onSpeechEnd,
      onVADMisfire: options.onVADMisfire,
      onFrameProcessed: options.onFrameProcessed,
    };

    // Merge options with defaults
    this.options = {
      ...DEFAULT_VAD_OPTIONS,
      model: options.model ?? DEFAULT_VAD_OPTIONS.model,
      positiveSpeechThreshold:
        options.positiveSpeechThreshold ?? DEFAULT_VAD_OPTIONS.positiveSpeechThreshold,
      negativeSpeechThreshold:
        options.negativeSpeechThreshold ?? DEFAULT_VAD_OPTIONS.negativeSpeechThreshold,
      preSpeechPadMs: options.preSpeechPadMs ?? DEFAULT_VAD_OPTIONS.preSpeechPadMs,
      postSpeechPadMs: options.postSpeechPadMs ?? DEFAULT_VAD_OPTIONS.postSpeechPadMs,
      minSpeechMs: options.minSpeechMs ?? DEFAULT_VAD_OPTIONS.minSpeechMs,
      redemptionMs: options.redemptionMs ?? DEFAULT_VAD_OPTIONS.redemptionMs,
      sampleRate: options.sampleRate ?? DEFAULT_VAD_OPTIONS.sampleRate,
      enableStats: options.enableStats ?? DEFAULT_VAD_OPTIONS.enableStats,
      statsInterval: options.statsInterval ?? DEFAULT_VAD_OPTIONS.statsInterval,
      submitUserSpeechOnPause:
        options.submitUserSpeechOnPause ?? DEFAULT_VAD_OPTIONS.submitUserSpeechOnPause,
      baseAssetPath: options.baseAssetPath,
      onnxWASMBasePath: options.onnxWASMBasePath,
      additionalAudioConstraints: options.additionalAudioConstraints,
    };
  }

  /**
   * Check if this processor is supported in the current browser.
   */
  isSupported(): boolean {
    return isVADSupported();
  }

  /**
   * Initialize the VAD processor.
   */
  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    this.streamStartWallClock = Date.now();

    if (this.debugMode) {
      debugLogConfig('VAD', {
        model: this.options.model,
        positiveSpeechThreshold: this.options.positiveSpeechThreshold,
        negativeSpeechThreshold: this.options.negativeSpeechThreshold,
        preSpeechPadMs: this.options.preSpeechPadMs,
        postSpeechPadMs: this.options.postSpeechPadMs,
        minSpeechMs: this.options.minSpeechMs,
        redemptionMs: this.options.redemptionMs,
        sampleRate: this.options.sampleRate,
      });
    }

    // Check browser support
    const support = getVADBrowserSupport();

    if (!support.vadSupported) {
      throw new VADError(
        VADErrorCode.NOT_SUPPORTED,
        support.unsupportedReason ?? 'VAD not supported in this browser'
      );
    }

    // Create source node from input track
    const stream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(stream);

    // Create destination for passthrough output
    this.destinationNode = audioContext.createMediaStreamDestination();

    // Connect source to destination (passthrough)
    this.sourceNode.connect(this.destinationNode);

    // Set the processed track (passthrough - VAD doesn't modify audio)
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];

    // Initialize MicVAD
    await this.initMicVAD(stream);

    // Update stats
    this.stats.isActive = true;

    // Start stats emission if enabled
    if (this.options.enableStats) {
      this.startStatsEmission();
    }
  }

  /**
   * Initialize the MicVAD from @ricky0123/vad-web.
   */
  private async initMicVAD(stream: MediaStream): Promise<void> {
    try {
      // Build vad-web options (library expects milliseconds, not frames)
      const vadOptions: Partial<RealTimeVADOptions> = {
        // Model configuration
        model: this.options.model,

        // Thresholds
        positiveSpeechThreshold: this.options.positiveSpeechThreshold,
        negativeSpeechThreshold: this.options.negativeSpeechThreshold,

        // Timing (in milliseconds - vad-web handles frame conversion internally)
        preSpeechPadMs: this.options.preSpeechPadMs,
        redemptionMs: this.options.redemptionMs,
        minSpeechMs: this.options.minSpeechMs,

        // Asset paths
        baseAssetPath: this.options.baseAssetPath ?? DEFAULT_BASE_ASSET_PATH,
        onnxWASMBasePath: this.options.onnxWASMBasePath ?? DEFAULT_ONNX_WASM_BASE_PATH,

        // Submit on pause
        submitUserSpeechOnPause: this.options.submitUserSpeechOnPause,

        // Callbacks
        onSpeechStart: () => {
          this.handleSpeechStart();
        },

        onSpeechRealStart: () => {
          this.handleSpeechRealStart();
        },

        onSpeechEnd: (audio: Float32Array) => {
          this.handleSpeechEnd(audio);
        },

        onVADMisfire: () => {
          this.handleVADMisfire();
        },

        onFrameProcessed: (
          probabilities: { isSpeech: number; notSpeech: number },
          frame: Float32Array
        ) => {
          this.handleFrameProcessed(probabilities, frame);
        },

        // Use the existing stream instead of requesting new mic access
        getStream: async () => stream,
      };

      // Create MicVAD instance
      this.micVAD = await MicVAD.new(vadOptions);

      // Start VAD processing
      this.micVAD.start();
    } catch (error) {
      throw new VADError(
        VADErrorCode.MODEL_LOAD_FAILED,
        `Failed to initialize MicVAD: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Handle speech start event.
   */
  private handleSpeechStart(): void {
    this.stats.isSpeaking = true;
    this.speechStartTime = Date.now();

    const payload: VADSpeechStartPayload = {
      timestamp: this.speechStartTime,
    };

    // Emit event
    this.emitData('vad-speech-start', payload);

    // Call callback
    this.callbacks.onSpeechStart?.();
  }

  /**
   * Handle real speech start event (confirmed speech).
   */
  private handleSpeechRealStart(): void {
    const payload: VADSpeechRealStartPayload = {
      timestamp: Date.now(),
    };

    // Emit event
    this.emitData('vad-speech-real-start', payload);

    // Call callback
    this.callbacks.onSpeechRealStart?.();
  }

  /**
   * Handle speech end event.
   */
  private handleSpeechEnd(audio: Float32Array): void {
    const endTime = Date.now();

    this.stats.isSpeaking = false;
    this.stats.speechSegmentsDetected++;
    this.stats.currentSpeechDuration = 0;

    const streamStartSec = (this.speechStartTime - this.streamStartWallClock) / 1000;
    const streamEndSec = (endTime - this.streamStartWallClock) / 1000;

    const payload: VADSpeechEndPayload = {
      audio,
      segmentNumber: this.stats.speechSegmentsDetected,
      startTime: this.speechStartTime,
      endTime,
      streamStartSec,
      streamEndSec,
      durationSec: streamEndSec - streamStartSec,
    };

    // Emit event
    this.emitData('vad-speech-end', payload);

    // Call callback
    this.callbacks.onSpeechEnd?.(audio);
  }

  /**
   * Handle VAD misfire event (speech too short).
   */
  private handleVADMisfire(): void {
    const duration = Date.now() - this.speechStartTime;

    this.stats.isSpeaking = false;
    this.stats.misfireCount++;
    this.stats.currentSpeechDuration = 0;

    const payload: VADMisfirePayload = {
      duration,
      timestamp: Date.now(),
    };

    // Emit event
    this.emitData('vad-misfire', payload);

    // Call callback
    this.callbacks.onVADMisfire?.();
  }

  /**
   * Handle frame processed event.
   */
  private handleFrameProcessed(
    probabilities: { isSpeech: number; notSpeech: number },
    frame: Float32Array
  ): void {
    // Update statistics
    this.stats.framesProcessed++;
    this.stats.speechProbability = probabilities.isSpeech;
    this.probabilitySum += probabilities.isSpeech;
    this.probabilityCount++;
    this.stats.averageSpeechProbability = this.probabilitySum / this.probabilityCount;

    if (this.stats.isSpeaking) {
      this.stats.currentSpeechDuration = Date.now() - this.speechStartTime;
    }

    const payload: VADFramePayload = {
      isSpeech: probabilities.isSpeech > this.options.positiveSpeechThreshold,
      probability: probabilities.isSpeech,
      notSpeechProbability: probabilities.notSpeech,
      timestamp: Date.now(),
    };

    // Emit event
    this.emitData('vad-frame', payload);

    // Call callback
    this.callbacks.onFrameProcessed?.(probabilities, frame);
  }

  /**
   * Start periodic stats emission.
   */
  private startStatsEmission(): void {
    this.statsInterval = setInterval(() => {
      this.stats.timestamp = Date.now();
      this.emitData('vad-stats', this.stats);
    }, this.options.statsInterval);
  }

  /**
   * Stop stats emission.
   */
  private stopStatsEmission(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * Destroy the processor and release resources.
   */
  protected async onDestroy(): Promise<void> {
    this.stopStatsEmission();

    // Destroy MicVAD
    if (this.micVAD) {
      this.micVAD.pause();
      this.micVAD.destroy();
      this.micVAD = null;
    }

    // Clean up audio nodes
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.destinationNode) {
      this.destinationNode = null;
    }

    this.stats.isActive = false;
  }

  /**
   * Enable the processor.
   */
  protected async onEnable(): Promise<void> {
    if (this.micVAD) {
      this.micVAD.start();
    }
    this.stats.isActive = true;
  }

  /**
   * Disable the processor.
   */
  protected async onDisable(): Promise<void> {
    if (this.micVAD) {
      this.micVAD.pause();
    }
    this.stats.isActive = false;
    this.stats.isSpeaking = false;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Get the current VAD model.
   */
  getModel(): VADModel {
    return this.options.model;
  }

  /**
   * Get current processing statistics.
   */
  getStats(): VADStats {
    return { ...this.stats, timestamp: Date.now() };
  }

  /**
   * Check if currently detecting speech.
   */
  isSpeaking(): boolean {
    return this.stats.isSpeaking;
  }

  /**
   * Get the current speech probability.
   */
  getSpeechProbability(): number {
    return this.stats.speechProbability;
  }

  /**
   * Get the current options.
   */
  getOptions(): VADOptions {
    return { ...this.options };
  }

  /**
   * Update thresholds dynamically.
   *
   * @param positiveSpeechThreshold - New positive threshold
   * @param negativeSpeechThreshold - New negative threshold
   */
  async updateThresholds(
    positiveSpeechThreshold: number,
    negativeSpeechThreshold: number
  ): Promise<void> {
    this.options.positiveSpeechThreshold = positiveSpeechThreshold;
    this.options.negativeSpeechThreshold = negativeSpeechThreshold;

    // Note: vad-web doesn't support runtime threshold updates,
    // would need to restart with new options
  }

  /**
   * Update options dynamically.
   * Note: Some options require restart to take effect.
   *
   * @param options - New options to merge
   */
  async updateOptions(options: Partial<VADOptions>): Promise<void> {
    if (options.enableStats !== undefined) {
      this.options.enableStats = options.enableStats;
      if (options.enableStats) {
        this.startStatsEmission();
      } else {
        this.stopStatsEmission();
      }
    }

    if (options.statsInterval !== undefined) {
      this.options.statsInterval = options.statsInterval;
      if (this.options.enableStats) {
        this.stopStatsEmission();
        this.startStatsEmission();
      }
    }

    // Update thresholds if provided
    if (
      options.positiveSpeechThreshold !== undefined ||
      options.negativeSpeechThreshold !== undefined
    ) {
      await this.updateThresholds(
        options.positiveSpeechThreshold ?? this.options.positiveSpeechThreshold,
        options.negativeSpeechThreshold ?? this.options.negativeSpeechThreshold
      );
    }
  }

  /**
   * Pause VAD processing.
   * If submitUserSpeechOnPause is true, will submit current speech segment.
   */
  pause(): void {
    if (this.micVAD) {
      this.micVAD.pause();
    }
    this.stats.isActive = false;
  }

  /**
   * Resume VAD processing.
   */
  start(): void {
    if (this.micVAD) {
      this.micVAD.start();
    }
    this.stats.isActive = true;
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      isActive: this.stats.isActive,
      isSpeaking: this.stats.isSpeaking,
      speechProbability: 0,
      currentSpeechDuration: 0,
      framesProcessed: 0,
      speechSegmentsDetected: 0,
      misfireCount: 0,
      averageSpeechProbability: 0,
      timestamp: Date.now(),
    };
    this.probabilitySum = 0;
    this.probabilityCount = 0;
  }
}

/**
 * Factory function to create a VADProcessor.
 *
 * @param options - Processor options
 * @returns VADProcessor instance
 */
export function createVAD(options?: VADOptionsWithCallbacks): VADProcessor {
  return new VADProcessor(options);
}
