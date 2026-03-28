/**
 * @arcaai/room - AudioTrack
 *
 * Audio track abstraction with processor support and feature toggling.
 * This is the main class for managing local audio capture and processing.
 */

import { TypedEventEmitter } from '../events/EventEmitter.js';
import { TrackEvent, type TrackEventMap, type ProcessorUpdatePayload, type FeatureUpdatePayload } from '../events/TrackEvents.js';
import type { TrackProcessor, AudioProcessorOptions } from '../processors/types.js';
import { AudioFeature, TrackState, type AudioCaptureOptions, type AudioLevelInfo, RoomError, RoomErrorCode } from '../types/index.js';
import { buildAudioConstraints, getTrackFeatures, applyFeatureConstraint } from '../utils/constraints.js';
import { calculateRMSLevel, calculatePeakLevel, createSmoothingCalculator, detectVoiceActivity } from '../utils/audioUtils.js';

/**
 * Mutex-like lock for serializing async operations.
 */
class AsyncLock {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

/**
 * AudioTrack options for creation.
 */
export interface AudioTrackOptions extends AudioCaptureOptions {
  /** AudioContext to use for processing */
  audioContext?: AudioContext;
  /** Initial processor to attach */
  processor?: TrackProcessor;
  /** Enable audio level monitoring */
  monitorAudioLevel?: boolean;
  /** Audio level update interval in ms */
  audioLevelInterval?: number;
}

/**
 * AudioTrack class for managing local audio capture and processing.
 *
 * Provides:
 * - Audio capture from microphone or other sources
 * - Processor attachment/detachment for audio processing
 * - Feature toggling (echo cancellation, noise suppression, etc.)
 * - Audio level monitoring
 * - Event emission for state changes
 *
 * @example
 * ```typescript
 * // Create and start audio capture
 * const track = new AudioTrack();
 * await track.initialize({ noiseSuppression: true });
 *
 * // Attach a processor
 * await track.setProcessor(myVADProcessor);
 *
 * // Toggle features
 * await track.setFeature(AudioFeature.ECHO_CANCELLATION, true);
 *
 * // Listen for events
 * track.on(TrackEvent.AudioLevelUpdate, (info) => {
 *   console.log('Level:', info.level, 'Speaking:', info.isSpeaking);
 * });
 *
 * // Cleanup
 * await track.stop();
 * ```
 */
export class AudioTrack extends TypedEventEmitter<TrackEventMap> {
  readonly kind = 'audio' as const;

  private sourceTrack: MediaStreamTrack | null = null;
  private currentProcessor: TrackProcessor | null = null;
  private audioContext: AudioContext | null = null;
  private state: TrackState = TrackState.IDLE;
  private options: AudioTrackOptions = {};

  // Audio level monitoring
  private analyserNode: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private levelMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private smoothLevel = createSmoothingCalculator(0.8);
  private peakLevel = 0;

  // Lock for processor changes
  private readonly processorLock = new AsyncLock();

  /**
   * Create a new AudioTrack.
   *
   * @param options - Optional configuration
   */
  constructor(options?: AudioTrackOptions) {
    super();
    this.options = options ?? {};
    this.audioContext = options?.audioContext ?? null;
  }

  /**
   * Initialize the audio track with capture from the microphone.
   *
   * @param options - Capture options
   */
  async initialize(options?: AudioCaptureOptions): Promise<void> {
    if (this.state !== TrackState.IDLE && this.state !== TrackState.ENDED) {
      throw new RoomError(RoomErrorCode.UNKNOWN, `Cannot initialize track in state: ${this.state}`);
    }

    this.state = TrackState.INITIALIZING;
    this.options = { ...this.options, ...options };

    try {
      const constraints = buildAudioConstraints(this.options);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: constraints,
      });

      this.sourceTrack = stream.getAudioTracks()[0] ?? null;

      if (!this.sourceTrack) {
        throw new RoomError(RoomErrorCode.DEVICE_NOT_FOUND, 'No audio track found in stream');
      }

      // Set up ended handler
      this.sourceTrack.onended = () => {
        this.handleTrackEnded();
      };

      // Set up audio level monitoring if enabled
      if (this.options.monitorAudioLevel !== false) {
        this.setupAudioLevelMonitoring();
      }

      // Attach initial processor if provided
      if (this.options.processor) {
        await this.setProcessor(this.options.processor);
      }

      this.state = TrackState.ACTIVE;
    } catch (error) {
      this.state = TrackState.ERROR;
      throw this.wrapError(error);
    }
  }

  /**
   * Initialize from an existing MediaStreamTrack.
   *
   * @param track - The MediaStreamTrack to use
   */
  async initializeFromTrack(track: MediaStreamTrack): Promise<void> {
    if (track.kind !== 'audio') {
      throw new RoomError(RoomErrorCode.UNKNOWN, 'Track must be an audio track');
    }

    this.state = TrackState.INITIALIZING;
    this.sourceTrack = track;

    track.onended = () => {
      this.handleTrackEnded();
    };

    if (this.options.monitorAudioLevel !== false) {
      this.setupAudioLevelMonitoring();
    }

    this.state = TrackState.ACTIVE;
  }

  /**
   * Get the current MediaStreamTrack.
   * Returns the processed track if a processor is attached, otherwise the source track.
   */
  get mediaStreamTrack(): MediaStreamTrack | null {
    return this.currentProcessor?.processedTrack ?? this.sourceTrack;
  }

  /**
   * Get the source (unprocessed) MediaStreamTrack.
   */
  get sourceMediaStreamTrack(): MediaStreamTrack | null {
    return this.sourceTrack;
  }

  /**
   * Get the current track state.
   */
  getState(): TrackState {
    return this.state;
  }

  /**
   * Check if the track is active.
   */
  isActive(): boolean {
    return this.state === TrackState.ACTIVE;
  }

  /**
   * Check if the track is muted.
   */
  isMuted(): boolean {
    return this.state === TrackState.MUTED || this.sourceTrack?.enabled === false;
  }

  /**
   * Mute the track.
   */
  mute(): void {
    if (this.sourceTrack) {
      this.sourceTrack.enabled = false;
      this.state = TrackState.MUTED;
      this.emit(TrackEvent.Muted);
    }
  }

  /**
   * Unmute the track.
   */
  unmute(): void {
    if (this.sourceTrack) {
      this.sourceTrack.enabled = true;
      this.state = TrackState.ACTIVE;
      this.emit(TrackEvent.Unmuted);
    }
  }

  /**
   * Set the AudioContext for this track.
   */
  setAudioContext(context: AudioContext): void {
    this.audioContext = context;
  }

  /**
   * Get the AudioContext.
   */
  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }

  // =========================================================================
  // Processor Management
  // =========================================================================

  /**
   * Set a processor for this track.
   * Replaces any existing processor.
   *
   * @param processor - The processor to attach
   */
  async setProcessor(processor: TrackProcessor): Promise<void> {
    const unlock = await this.processorLock.acquire();

    try {
      if (!this.sourceTrack) {
        throw new RoomError(RoomErrorCode.TRACK_NOT_FOUND, 'Track not initialized');
      }

      if (!this.audioContext) {
        throw new RoomError(RoomErrorCode.AUDIO_CONTEXT_SUSPENDED, 'AudioContext required for processor');
      }

      const previousProcessor = this.currentProcessor;

      // Stop existing processor
      if (previousProcessor) {
        await this.stopProcessorInternal();
      }

      // Initialize new processor
      const processorOptions: AudioProcessorOptions = {
        kind: 'audio',
        track: this.sourceTrack,
        audioContext: this.audioContext,
      };

      await processor.init(processorOptions);
      this.currentProcessor = processor;

      // Call onAttach if available
      if (processor.onAttach) {
        await processor.onAttach();
      }

      // Emit event
      const payload: ProcessorUpdatePayload = {
        processor,
        previousProcessor: previousProcessor ?? undefined,
      };
      this.emit(TrackEvent.ProcessorUpdate, payload);
    } finally {
      unlock();
    }
  }

  /**
   * Stop and remove the current processor.
   */
  async stopProcessor(): Promise<void> {
    const unlock = await this.processorLock.acquire();

    try {
      await this.stopProcessorInternal();
    } finally {
      unlock();
    }
  }

  /**
   * Internal processor stop (without lock).
   */
  private async stopProcessorInternal(): Promise<void> {
    if (!this.currentProcessor) return;

    const processor = this.currentProcessor;

    // Call onDetach if available
    if (processor.onDetach) {
      await processor.onDetach();
    }

    // Stop the processed track
    if (processor.processedTrack) {
      processor.processedTrack.stop();
    }

    // Destroy the processor
    await processor.destroy();

    this.currentProcessor = null;

    // Emit event
    const payload: ProcessorUpdatePayload = {
      processor: undefined,
      previousProcessor: processor,
    };
    this.emit(TrackEvent.ProcessorUpdate, payload);
  }

  /**
   * Get the current processor.
   */
  getProcessor(): TrackProcessor | null {
    return this.currentProcessor;
  }

  /**
   * Check if a processor is attached.
   */
  hasProcessor(): boolean {
    return this.currentProcessor !== null;
  }

  // =========================================================================
  // Feature Management
  // =========================================================================

  /**
   * Set a feature enabled or disabled.
   *
   * @param feature - The feature to toggle
   * @param enabled - Whether to enable or disable
   */
  async setFeature(feature: AudioFeature, enabled: boolean): Promise<void> {
    if (!this.sourceTrack) {
      throw new RoomError(RoomErrorCode.TRACK_NOT_FOUND, 'Track not initialized');
    }

    await applyFeatureConstraint(this.sourceTrack, feature, enabled);

    const payload: FeatureUpdatePayload = { feature, enabled };
    this.emit(TrackEvent.FeatureUpdate, payload);
  }

  /**
   * Get the current state of all features.
   */
  getFeatures(): Map<AudioFeature, boolean> {
    if (!this.sourceTrack) {
      return new Map();
    }
    return getTrackFeatures(this.sourceTrack);
  }

  /**
   * Check if a specific feature is enabled.
   */
  isFeatureEnabled(feature: AudioFeature): boolean {
    return this.getFeatures().get(feature) ?? false;
  }

  /**
   * Get the track settings.
   */
  getSettings(): MediaTrackSettings | null {
    return this.sourceTrack?.getSettings() ?? null;
  }

  // =========================================================================
  // Audio Level Monitoring
  // =========================================================================

  /**
   * Set up audio level monitoring using Web Audio API.
   */
  private setupAudioLevelMonitoring(): void {
    if (!this.sourceTrack || !this.audioContext) return;

    try {
      // Create analyser node
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 2048;

      // Create source from track
      const stream = new MediaStream([this.sourceTrack]);
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.sourceNode.connect(this.analyserNode);

      // Start monitoring
      const interval = this.options.audioLevelInterval ?? 50;
      this.levelMonitorInterval = setInterval(() => {
        this.updateAudioLevel();
      }, interval);
    } catch (error) {
      console.warn('Failed to set up audio level monitoring:', error);
    }
  }

  /**
   * Update audio level and emit event.
   */
  private updateAudioLevel(): void {
    if (!this.analyserNode) return;

    const bufferLength = this.analyserNode.fftSize;
    const dataArray = new Float32Array(bufferLength);
    this.analyserNode.getFloatTimeDomainData(dataArray);

    const currentLevel = calculateRMSLevel(dataArray);
    const peak = calculatePeakLevel(dataArray);
    const smoothed = this.smoothLevel(currentLevel);

    // Update peak
    if (peak > this.peakLevel) {
      this.peakLevel = peak;
    }

    const info: AudioLevelInfo = {
      level: smoothed,
      isSpeaking: detectVoiceActivity(smoothed),
      peak: this.peakLevel,
      average: smoothed,
    };

    this.emit(TrackEvent.AudioLevelUpdate, info);
  }

  /**
   * Reset peak level.
   */
  resetPeakLevel(): void {
    this.peakLevel = 0;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Restart the track with new options.
   *
   * @param options - New capture options
   */
  async restart(options?: AudioCaptureOptions): Promise<void> {
    const processor = this.currentProcessor;

    await this.stop();
    await this.initialize(options);

    // Re-attach processor if there was one
    if (processor) {
      await this.setProcessor(processor);
    }

    this.emit(TrackEvent.Restarted);
  }

  /**
   * Stop the track and release resources.
   */
  async stop(): Promise<void> {
    // Stop processor
    if (this.currentProcessor) {
      await this.stopProcessor();
    }

    // Stop level monitoring
    if (this.levelMonitorInterval) {
      clearInterval(this.levelMonitorInterval);
      this.levelMonitorInterval = null;
    }

    // Disconnect audio nodes
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.analyserNode = null;

    // Stop the source track
    if (this.sourceTrack) {
      this.sourceTrack.stop();
      this.sourceTrack = null;
    }

    this.state = TrackState.ENDED;
    this.emit(TrackEvent.Ended);
  }

  /**
   * Handle source track ended event.
   */
  private handleTrackEnded(): void {
    this.state = TrackState.ENDED;
    this.emit(TrackEvent.Ended);
  }

  /**
   * Wrap an error in a RoomError.
   */
  private wrapError(error: unknown): RoomError {
    if (error instanceof RoomError) {
      return error;
    }

    if (error instanceof DOMException) {
      switch (error.name) {
        case 'NotAllowedError':
          return new RoomError(RoomErrorCode.PERMISSION_DENIED, 'Microphone permission denied', error);
        case 'NotFoundError':
          return new RoomError(RoomErrorCode.DEVICE_NOT_FOUND, 'No microphone found', error);
        case 'NotReadableError':
          return new RoomError(RoomErrorCode.DEVICE_IN_USE, 'Microphone is in use by another application', error);
        default:
          return new RoomError(RoomErrorCode.UNKNOWN, error.message, error);
      }
    }

    return new RoomError(RoomErrorCode.UNKNOWN, error instanceof Error ? error.message : 'Unknown error', error instanceof Error ? error : undefined);
  }
}
