/**
 * @arcaai/stt - AudioBufferManager
 *
 * Manages audio buffering for chunked processing with overlap.
 * Optimized for Whisper model processing which works best with 30-second chunks.
 */

import { WHISPER_SAMPLE_RATE, prepareFloat32ForWhisper, concatenateFloat32Arrays } from '../utils/audioResampler.js';

/**
 * Options for AudioBufferManager.
 */
export interface AudioBufferManagerOptions {
  /**
   * Target sample rate (samples per second).
   * @default 16000 (Whisper sample rate)
   */
  sampleRate?: number;

  /**
   * Chunk length in seconds.
   * @default 30
   */
  chunkLengthS?: number;

  /**
   * Overlap length in seconds.
   * This amount of audio is retained between chunks for context.
   * @default 5
   */
  overlapLengthS?: number;

  /**
   * Minimum buffer size in seconds before emitting a chunk.
   * @default 1
   */
  minBufferS?: number;
}

/**
 * Default options for AudioBufferManager.
 */
export const DEFAULT_BUFFER_OPTIONS: Required<AudioBufferManagerOptions> = {
  sampleRate: WHISPER_SAMPLE_RATE,
  chunkLengthS: 30,
  overlapLengthS: 5,
  minBufferS: 1,
};

/**
 * Manages audio buffering for chunked STT processing.
 *
 * Features:
 * - Accumulates audio samples until chunk size is reached
 * - Maintains overlap between chunks for better context
 * - Handles sample rate conversion
 * - Provides efficient buffer management
 *
 * @example
 * ```typescript
 * const bufferManager = new AudioBufferManager({
 *   chunkLengthS: 30,
 *   overlapLengthS: 5,
 * });
 *
 * // Add audio samples
 * bufferManager.append(audioSamples, sampleRate);
 *
 * // Get chunks when ready
 * while (bufferManager.hasChunk()) {
 *   const chunk = bufferManager.getChunk();
 *   // Process chunk with STT
 * }
 * ```
 */
export class AudioBufferManager {
  private buffer: Float32Array[] = [];
  private totalSamples = 0;
  private readonly options: Required<AudioBufferManagerOptions>;
  private readonly chunkSamples: number;
  private readonly overlapSamples: number;
  private readonly minBufferSamples: number;

  constructor(options: AudioBufferManagerOptions = {}) {
    this.options = {
      ...DEFAULT_BUFFER_OPTIONS,
      ...options,
    };

    // Calculate sample counts
    this.chunkSamples = Math.floor(this.options.chunkLengthS * this.options.sampleRate);
    this.overlapSamples = Math.floor(this.options.overlapLengthS * this.options.sampleRate);
    this.minBufferSamples = Math.floor(this.options.minBufferS * this.options.sampleRate);
  }

  /**
   * Append audio samples to the buffer.
   *
   * @param samples - Audio samples to append
   * @param sampleRate - Sample rate of the input audio
   */
  append(samples: Float32Array, sampleRate: number = this.options.sampleRate): void {
    // Resample if needed
    const resampled = prepareFloat32ForWhisper(samples, sampleRate);

    // Add to buffer
    this.buffer.push(resampled);
    this.totalSamples += resampled.length;
  }

  /**
   * Check if a chunk is available for processing.
   */
  hasChunk(): boolean {
    return this.totalSamples >= this.chunkSamples;
  }

  /**
   * Check if there's any audio in the buffer.
   */
  hasAudio(): boolean {
    return this.totalSamples > 0;
  }

  /**
   * Check if there's enough audio for partial processing.
   */
  hasMinBuffer(): boolean {
    return this.totalSamples >= this.minBufferSamples;
  }

  /**
   * Get the next chunk for processing.
   * Returns null if not enough audio is buffered.
   *
   * After returning a chunk, retains overlap samples for context.
   */
  getChunk(): Float32Array | null {
    if (!this.hasChunk()) {
      return null;
    }

    // Concatenate all buffered audio
    const fullBuffer = concatenateFloat32Arrays(this.buffer);

    // Extract chunk
    const chunk = fullBuffer.slice(0, this.chunkSamples);

    // Retain overlap samples for context
    const remainingSamples = this.totalSamples - this.chunkSamples + this.overlapSamples;
    if (remainingSamples > 0) {
      const startIndex = this.chunkSamples - this.overlapSamples;
      const remaining = fullBuffer.slice(startIndex);
      this.buffer = [remaining];
      this.totalSamples = remaining.length;
    } else {
      this.buffer = [];
      this.totalSamples = 0;
    }

    return chunk;
  }

  /**
   * Get all remaining audio without chunking.
   * Used for final processing when stream ends.
   */
  flush(): Float32Array | null {
    if (this.totalSamples === 0) {
      return null;
    }

    const result = concatenateFloat32Arrays(this.buffer);
    this.buffer = [];
    this.totalSamples = 0;

    return result;
  }

  /**
   * Get the current buffer contents without consuming.
   * Useful for partial/interim transcription.
   */
  peek(): Float32Array | null {
    if (this.totalSamples === 0) {
      return null;
    }

    return concatenateFloat32Arrays(this.buffer);
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer = [];
    this.totalSamples = 0;
  }

  /**
   * Get the current buffer size in samples.
   */
  getSampleCount(): number {
    return this.totalSamples;
  }

  /**
   * Get the current buffer size in seconds.
   */
  getDuration(): number {
    return this.totalSamples / this.options.sampleRate;
  }

  /**
   * Get the configured chunk length in samples.
   */
  getChunkSamples(): number {
    return this.chunkSamples;
  }

  /**
   * Get the configured chunk length in seconds.
   */
  getChunkDuration(): number {
    return this.options.chunkLengthS;
  }

  /**
   * Get the configured overlap length in samples.
   */
  getOverlapSamples(): number {
    return this.overlapSamples;
  }

  /**
   * Get the sample rate.
   */
  getSampleRate(): number {
    return this.options.sampleRate;
  }

  /**
   * Get buffer statistics.
   */
  getStats(): AudioBufferStats {
    return {
      sampleCount: this.totalSamples,
      durationS: this.getDuration(),
      chunkReady: this.hasChunk(),
      bufferCount: this.buffer.length,
      chunkSamples: this.chunkSamples,
      overlapSamples: this.overlapSamples,
    };
  }
}

/**
 * Statistics about the audio buffer.
 */
export interface AudioBufferStats {
  /**
   * Total samples in buffer.
   */
  sampleCount: number;

  /**
   * Duration in seconds.
   */
  durationS: number;

  /**
   * Whether a full chunk is ready.
   */
  chunkReady: boolean;

  /**
   * Number of buffer segments.
   */
  bufferCount: number;

  /**
   * Configured chunk size in samples.
   */
  chunkSamples: number;

  /**
   * Configured overlap size in samples.
   */
  overlapSamples: number;
}
