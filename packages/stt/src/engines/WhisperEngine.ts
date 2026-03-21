/**
 * @arcaai/stt - WhisperEngine
 *
 * Whisper model engine using @huggingface/transformers.
 * Supports WebGPU acceleration with WASM fallback.
 */

import type {
  TranscriptionResult,
  TranscriptionTimestamp,
  ComputeDevice,
  LanguageLocale,
} from '../types/index.js';
import { getLanguageCode } from '../types/index.js';
import type { EngineConfig, TranscribeOptions } from './types.js';
import { BaseEngine } from './BaseEngine.js';
import { isWebGPUSupported, isWebAssemblySupported } from '../utils/browserSupport.js';

// Dynamic import for transformers.js to allow tree-shaking
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pipeline = any;

/**
 * Whisper engine using Transformers.js.
 *
 * Features:
 * - Automatic WebGPU/WASM device selection
 * - Support for multiple Whisper model sizes
 * - Quantized model support for smaller downloads
 * - Chunk-based transcription with timestamps
 *
 * @example
 * ```typescript
 * const engine = new WhisperEngine();
 *
 * await engine.init({
 *   model: 'tiny',
 *   language: 'en',
 *   device: 'auto',
 *   quantized: true,
 * });
 *
 * const result = await engine.transcribe(audioSamples);
 * console.log(result.text);
 *
 * await engine.destroy();
 * ```
 */
export class WhisperEngine extends BaseEngine {
  readonly name = 'whisper-transformers';

  private pipeline: Pipeline | null = null;
  private actualDevice: ComputeDevice = 'wasm';

  isSupported(): boolean {
    // Requires WebAssembly at minimum
    return isWebAssemblySupported();
  }

  async init(config: EngineConfig): Promise<void> {
    if (this.initialized) {
      await this.destroy();
    }

    this.config = config;
    const startTime = performance.now();

    try {
      // Determine device to use
      this.actualDevice = this.resolveDevice(config.device);

      const modelId = config.modelPath ?? this.getModelId(
        config.model,
        config.language,
        config.quantized,
        config.returnTimestamps,
      );

      // Report loading progress
      config.onProgress?.({
        status: 'loading',
        progress: 0,
        file: modelId,
      });

      // Dynamic import of transformers
      const { pipeline } = await import('@huggingface/transformers');

      // Specify dtype to avoid "dtype not specified" warnings and optimize GPU memory.
      // fp16 for WebGPU (faster, less VRAM), fp32 for WASM (no fp16 support).
      const dtype = this.actualDevice === 'webgpu'
        ? { encoder_model: 'fp16' as const, decoder_model_merged: 'fp16' as const }
        : undefined;

      // Create the pipeline with progress callback
      this.pipeline = await pipeline(
        'automatic-speech-recognition',
        modelId,
        {
          device: this.actualDevice === 'webgpu' ? 'webgpu' : undefined,
          dtype,
          progress_callback: (progressData: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
            if (progressData.status === 'progress' && progressData.progress !== undefined) {
              config.onProgress?.({
                status: 'downloading',
                progress: progressData.progress / 100,
                file: progressData.file,
                loaded: progressData.loaded,
                total: progressData.total,
              });
            } else if (progressData.status === 'done') {
              config.onProgress?.({
                status: 'loading',
                progress: 1,
                file: progressData.file,
              });
            }
          },
        }
      );

      this.modelLoadTimeMs = performance.now() - startTime;
      this.initialized = true;

      config.onProgress?.({
        status: 'ready',
        progress: 1,
      });
    } catch (error) {
      config.onProgress?.({
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async transcribe(
    audio: Float32Array,
    options?: TranscribeOptions
  ): Promise<TranscriptionResult> {
    if (!this.pipeline || !this.config) {
      throw new Error('Engine not initialized. Call init() first.');
    }

    this.transcribing = true;
    const startTime = performance.now();

    try {
      const language = options?.language ?? this.config.language;
      const returnTimestamps = options?.returnTimestamps ?? this.config.returnTimestamps;

      // English-only models (.en suffix) reject `language` and `task` parameters.
      // Only pass language for multilingual models.
      const modelId = this.config.modelPath ?? this.getModelId(
        this.config.model,
        this.config.language,
        this.config.quantized,
        this.config.returnTimestamps,
      );
      const isEnglishOnlyModel = modelId.endsWith('.en');
      const allowAutoLanguage =
        Boolean(this.config.codeSwitching) || language.toLowerCase() === 'auto';

      const transcribeOptions: Record<string, unknown> = {
        return_timestamps: returnTimestamps,
      };

      if (!isEnglishOnlyModel && !allowAutoLanguage) {
        transcribeOptions.language = this.normalizeLanguage(language);
      }

      // Add chunking for longer audio
      if (audio.length > this.config.chunkLengthS * 16000) {
        transcribeOptions.chunk_length_s = this.config.chunkLengthS;
        transcribeOptions.stride_length_s = this.config.overlapLengthS;
      }

      type PipelineResult = {
        text: string;
        chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
      };

      let result: PipelineResult;
      try {
        result = await this.pipeline(audio, transcribeOptions) as PipelineResult;
      } catch (pipelineError) {
        const msg = pipelineError instanceof Error ? pipelineError.message : String(pipelineError);
        if (returnTimestamps === 'word' && /cross.attentions|output_attentions/i.test(msg)) {
          transcribeOptions.return_timestamps = true;
          result = await this.pipeline(audio, transcribeOptions) as PipelineResult;
        } else {
          throw pipelineError;
        }
      }

      const latencyMs = performance.now() - startTime;
      this.recordTranscription(latencyMs);

      // Parse timestamps if available
      let timestamps: TranscriptionTimestamp[] | undefined;
      if (result.chunks && result.chunks.length > 0) {
        timestamps = result.chunks.map((chunk) => ({
          start: chunk.timestamp[0],
          end: chunk.timestamp[1] ?? chunk.timestamp[0],
          text: chunk.text,
        }));
      }

      return {
        text: result.text.trim(),
        isFinal: true,
        language,
        timestamps,
        duration: audio.length / 16000,
        latencyMs,
      };
    } finally {
      this.transcribing = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.pipeline) {
      // Transformers.js pipelines are auto-cleaned by GC
      // but we can release our reference
      this.pipeline = null;
    }

    this.config = null;
    this.initialized = false;
    this.transcribing = false;
  }

  /**
   * Get the actual device being used.
   */
  getDevice(): ComputeDevice {
    return this.actualDevice;
  }

  /**
   * Resolve the device to use based on capabilities.
   */
  private resolveDevice(requestedDevice: ComputeDevice): ComputeDevice {
    if (requestedDevice === 'webgpu') {
      return isWebGPUSupported() ? 'webgpu' : 'wasm';
    }

    if (requestedDevice === 'auto') {
      return isWebGPUSupported() ? 'webgpu' : 'wasm';
    }

    return 'wasm';
  }

  /**
   * Normalize language locale to ISO 639-1 code for Whisper.
   * Whisper uses ISO 639-1 codes (e.g., 'en', 'es', 'fr').
   */
  private normalizeLanguage(language: LanguageLocale): string {
    return getLanguageCode(language);
  }
}
