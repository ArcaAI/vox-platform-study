/**
 * @arcaai/stt - Provider Types
 *
 * Type definitions for STT provider implementations.
 */

import type { TranscriptionResult, STTStats, RemoteProviderConfig, ProviderConfig } from '../types/index.js';

/**
 * Callback for transcription results.
 */
export type TranscriptionCallback = (result: TranscriptionResult) => void;

/**
 * Callback for errors.
 */
export type ErrorCallback = (error: Error) => void;

/**
 * Interface for STT provider implementations.
 */
export interface STTProvider {
  /**
   * Provider name for identification.
   */
  readonly name: string;

  /**
   * Provider type.
   *
   * @deprecated TASK-1006 — the in-browser Whisper provider was removed;
   * `'remote'` is the only value (TASK-865: the browser never runs a model).
   */
  readonly type: 'remote';

  /**
   * Check if this provider is supported in the current environment.
   */
  isSupported(): boolean;

  /**
   * Initialize the provider with configuration.
   */
  init(config: ProviderConfig | RemoteProviderConfig): Promise<void>;

  /**
   * Start streaming audio to the backend.
   */
  start(): Promise<void>;

  /**
   * Stop processing audio.
   */
  stop(): Promise<void>;

  /**
   * Process audio samples.
   *
   * @param audio - Audio samples (Float32Array)
   * @param sampleRate - Sample rate of the audio
   */
  processAudio(audio: Float32Array, sampleRate: number): Promise<void>;

  /**
   * Transcribe a specific audio segment.
   * Returns the transcription result directly.
   *
   * @param audio - Audio samples (Float32Array at 16kHz)
   * @returns Transcription result
   */
  transcribeSegment(audio: Float32Array): Promise<TranscriptionResult>;

  /**
   * Destroy the provider and release resources.
   */
  destroy(): Promise<void>;

  /**
   * Check if the provider is initialized and ready.
   */
  isReady(): boolean;

  /**
   * Check if the provider is currently processing.
   */
  isProcessing(): boolean;

  /**
   * Set the callback for transcription results.
   */
  onTranscription(callback: TranscriptionCallback): void;

  /**
   * Set the callback for errors.
   */
  onError(callback: ErrorCallback): void;

  /**
   * Get provider statistics.
   */
  getStats(): STTStats;
}
