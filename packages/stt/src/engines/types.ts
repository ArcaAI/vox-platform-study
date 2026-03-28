/**
 * @arcaai/stt - Engine Types
 *
 * Type definitions for STT engine implementations.
 */

import type { ComputeDevice, WhisperModelSize, TranscriptionResult, ModelLoadProgress, LanguageLocale } from '../types/index.js';

/**
 * Configuration for STT engines.
 */
export interface EngineConfig {
  /**
   * Model to use.
   */
  model: WhisperModelSize;

  /**
   * Language locale for transcription.
   */
  language: LanguageLocale;

  /**
   * Compute device.
   */
  device: ComputeDevice;

  /**
   * Whether to use quantized models.
   */
  quantized: boolean;

  /**
   * Custom model path.
   */
  modelPath?: string;

  /**
   * Chunk length in seconds.
   */
  chunkLengthS: number;

  /**
   * Overlap length in seconds between chunks.
   */
  overlapLengthS: number;

  /**
   * Whether to return timestamps.
   */
  returnTimestamps: boolean | 'word';

  /**
   * If true, do not force source language and let model auto-detect.
   */
  codeSwitching?: boolean;

  /**
   * Progress callback for model loading.
   */
  onProgress?: (progress: ModelLoadProgress) => void;
}

/**
 * Transcription options for a single transcription call.
 */
export interface TranscribeOptions {
  /**
   * Language override for this transcription.
   */
  language?: string;

  /**
   * Whether to return timestamps.
   */
  returnTimestamps?: boolean | 'word';

  /**
   * Initial prompt to guide transcription.
   */
  prompt?: string;
}

/**
 * Engine statistics.
 */
export interface EngineStats {
  /**
   * Whether the engine is initialized.
   */
  isInitialized: boolean;

  /**
   * Whether the engine is currently transcribing.
   */
  isTranscribing: boolean;

  /**
   * Model in use.
   */
  model: string;

  /**
   * Compute device in use.
   */
  device: ComputeDevice;

  /**
   * Total transcriptions performed.
   */
  transcriptionCount: number;

  /**
   * Average latency in milliseconds.
   */
  averageLatencyMs: number;

  /**
   * Model load time in milliseconds.
   */
  modelLoadTimeMs?: number;
}

/**
 * Interface for STT engine implementations.
 */
export interface STTEngine {
  /**
   * Engine name for identification.
   */
  readonly name: string;

  /**
   * Check if this engine is supported in the current environment.
   */
  isSupported(): boolean;

  /**
   * Initialize the engine with configuration.
   */
  init(config: EngineConfig): Promise<void>;

  /**
   * Transcribe audio samples.
   *
   * @param audio - Audio samples (Float32Array at 16kHz)
   * @param options - Transcription options
   * @returns Transcription result
   */
  transcribe(audio: Float32Array, options?: TranscribeOptions): Promise<TranscriptionResult>;

  /**
   * Destroy the engine and release resources.
   */
  destroy(): Promise<void>;

  /**
   * Check if the engine is initialized and ready.
   */
  isReady(): boolean;

  /**
   * Get engine statistics.
   */
  getStats(): EngineStats;
}
