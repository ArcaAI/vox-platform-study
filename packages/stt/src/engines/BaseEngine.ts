/**
 * @arcaai/stt - BaseEngine
 *
 * Abstract base class for STT engine implementations.
 */

import type { ComputeDevice, TranscriptionResult } from '../types/index.js';
import type { STTEngine, EngineConfig, EngineStats, TranscribeOptions } from './types.js';

/**
 * Abstract base class for STT engines.
 * Provides common functionality for all engine implementations.
 */
export abstract class BaseEngine implements STTEngine {
  abstract readonly name: string;

  protected config: EngineConfig | null = null;
  protected initialized = false;
  protected transcribing = false;
  protected transcriptionCount = 0;
  protected totalLatencyMs = 0;
  protected modelLoadTimeMs?: number;

  abstract isSupported(): boolean;

  abstract init(config: EngineConfig): Promise<void>;

  abstract transcribe(audio: Float32Array, options?: TranscribeOptions): Promise<TranscriptionResult>;

  abstract destroy(): Promise<void>;

  isReady(): boolean {
    return this.initialized;
  }

  getStats(): EngineStats {
    return {
      isInitialized: this.initialized,
      isTranscribing: this.transcribing,
      model: this.config?.model ?? 'unknown',
      device: (this.config?.device ?? 'wasm') as ComputeDevice,
      transcriptionCount: this.transcriptionCount,
      averageLatencyMs: this.transcriptionCount > 0 ? this.totalLatencyMs / this.transcriptionCount : 0,
      modelLoadTimeMs: this.modelLoadTimeMs,
    };
  }

  /**
   * Record a transcription with its latency.
   */
  protected recordTranscription(latencyMs: number): void {
    this.transcriptionCount++;
    this.totalLatencyMs += latencyMs;
  }

  /**
   * Get the model ID for Hugging Face Hub.
   *
   * When `returnTimestamps` is `'word'`, selects the `_timestamped` ONNX variant
   * which was exported with `output_attentions=True` — required for cross-attention
   * based word-level timestamp extraction (DTW).
   *
   * Note: `_timestamped` models are only published as multilingual variants
   * (e.g. `whisper-tiny_timestamped`), so the `.en` suffix is omitted when
   * word-level timestamps are requested.
   */
  protected getModelId(model: string, language: string, quantized: boolean, returnTimestamps?: boolean | 'word'): string {
    const needsTimestampedModel = returnTimestamps === 'word';
    const isEnglish = language === 'en' || language.startsWith('en-');
    const modelSuffix = isEnglish && !needsTimestampedModel ? '.en' : '';
    const prefix = quantized ? 'onnx-community' : 'Xenova';
    const timestampSuffix = needsTimestampedModel ? '_timestamped' : '';

    return `${prefix}/whisper-${model}${modelSuffix}${timestampSuffix}`;
  }
}
