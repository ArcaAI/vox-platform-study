/**
 * @arcaai/vad - Frame Processor
 *
 * Utilities for accumulating audio samples into frames for VAD processing.
 */

import type { VADModel } from '../types/index.js';
import { getFrameSamplesForModel } from './browserSupport.js';

/**
 * Frame size for Silero VAD v5 (512 samples).
 */
export const FRAME_SIZE_V5 = 512;

/**
 * Frame size for legacy Silero VAD (1536 samples).
 */
export const FRAME_SIZE_LEGACY = 1536;

/**
 * Callback type for when a complete frame is ready.
 */
export type OnFrameReadyCallback = (frame: Float32Array) => void;

/**
 * FrameAccumulator collects audio samples into fixed-size frames.
 *
 * This is useful when the audio input comes in arbitrary chunk sizes
 * (e.g., 128 samples from AudioWorklet) but the VAD model requires
 * specific frame sizes (512 for v5, 1536 for legacy).
 *
 * @example
 * ```typescript
 * const accumulator = new FrameAccumulator('v5', (frame) => {
 *   // Process frame with VAD
 *   const result = vad.processFrame(frame);
 * });
 *
 * // Feed audio chunks from AudioWorklet
 * accumulator.process(audioChunk);
 * ```
 */
export class FrameAccumulator {
  private frameSize: number;
  private buffer: Float32Array;
  private bufferIndex: number = 0;
  private onFrameReady: OnFrameReadyCallback;

  /**
   * Create a new FrameAccumulator.
   *
   * @param model - VAD model type ('v5' or 'legacy')
   * @param onFrameReady - Callback when a complete frame is ready
   */
  constructor(model: VADModel, onFrameReady: OnFrameReadyCallback) {
    this.frameSize = getFrameSamplesForModel(model);
    this.buffer = new Float32Array(this.frameSize);
    this.onFrameReady = onFrameReady;
  }

  /**
   * Process an audio chunk.
   * May trigger multiple frame callbacks if the chunk is large enough.
   *
   * @param samples - Audio samples to process
   */
  process(samples: Float32Array): void {
    let samplesIndex = 0;

    while (samplesIndex < samples.length) {
      // Calculate how many samples we can copy
      const remainingInBuffer = this.frameSize - this.bufferIndex;
      const remainingInSamples = samples.length - samplesIndex;
      const toCopy = Math.min(remainingInBuffer, remainingInSamples);

      // Copy samples to buffer
      for (let i = 0; i < toCopy; i++) {
        this.buffer[this.bufferIndex + i] = samples[samplesIndex + i]!;
      }

      this.bufferIndex += toCopy;
      samplesIndex += toCopy;

      // If buffer is full, emit frame
      if (this.bufferIndex >= this.frameSize) {
        // Create a copy of the frame to pass to callback
        const frame = new Float32Array(this.buffer);
        this.onFrameReady(frame);
        this.bufferIndex = 0;
      }
    }
  }

  /**
   * Get the current buffer fill level.
   *
   * @returns Number of samples currently in the buffer
   */
  getBufferLevel(): number {
    return this.bufferIndex;
  }

  /**
   * Get the frame size.
   *
   * @returns Frame size in samples
   */
  getFrameSize(): number {
    return this.frameSize;
  }

  /**
   * Get the percentage of buffer filled.
   *
   * @returns Buffer fill percentage (0-1)
   */
  getBufferFillPercentage(): number {
    return this.bufferIndex / this.frameSize;
  }

  /**
   * Reset the accumulator, discarding any buffered samples.
   */
  reset(): void {
    this.bufferIndex = 0;
    this.buffer.fill(0);
  }

  /**
   * Flush the remaining buffer content.
   * Pads with zeros if not full and calls the callback.
   *
   * @returns The flushed frame (may be zero-padded)
   */
  flush(): Float32Array | null {
    if (this.bufferIndex === 0) {
      return null;
    }

    // Zero-pad remaining buffer
    for (let i = this.bufferIndex; i < this.frameSize; i++) {
      this.buffer[i] = 0;
    }

    const frame = new Float32Array(this.buffer);
    this.bufferIndex = 0;

    return frame;
  }
}

/**
 * RingBuffer for audio sample storage.
 * Useful for maintaining a sliding window of audio for pre-speech padding.
 */
export class AudioRingBuffer {
  private buffer: Float32Array;
  private writeIndex: number = 0;
  private readIndex: number = 0;
  private count: number = 0;
  private capacity: number;

  /**
   * Create a new AudioRingBuffer.
   *
   * @param capacity - Maximum number of samples to store
   */
  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
  }

  /**
   * Write samples to the buffer.
   * Overwrites oldest samples if buffer is full.
   *
   * @param samples - Samples to write
   */
  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writeIndex] = samples[i]!;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;

      if (this.count < this.capacity) {
        this.count++;
      } else {
        // Buffer is full, advance read index
        this.readIndex = (this.readIndex + 1) % this.capacity;
      }
    }
  }

  /**
   * Read all samples from the buffer.
   *
   * @returns All samples in order (oldest to newest)
   */
  readAll(): Float32Array {
    const output = new Float32Array(this.count);
    let readIdx = this.readIndex;

    for (let i = 0; i < this.count; i++) {
      output[i] = this.buffer[readIdx]!;
      readIdx = (readIdx + 1) % this.capacity;
    }

    return output;
  }

  /**
   * Read the last N samples from the buffer.
   *
   * @param n - Number of samples to read
   * @returns The last N samples
   */
  readLast(n: number): Float32Array {
    const toRead = Math.min(n, this.count);
    const output = new Float32Array(toRead);

    // Calculate starting position for last N samples
    let startIdx = (this.writeIndex - toRead + this.capacity) % this.capacity;

    for (let i = 0; i < toRead; i++) {
      output[i] = this.buffer[startIdx]!;
      startIdx = (startIdx + 1) % this.capacity;
    }

    return output;
  }

  /**
   * Get the current number of samples in the buffer.
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Get the buffer capacity.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Check if the buffer is full.
   */
  isFull(): boolean {
    return this.count >= this.capacity;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
    this.buffer.fill(0);
  }
}

/**
 * Calculate the number of samples for a given duration.
 *
 * @param durationMs - Duration in milliseconds
 * @param sampleRate - Sample rate in Hz
 * @returns Number of samples
 */
export function durationToSamples(durationMs: number, sampleRate: number): number {
  return Math.ceil((durationMs / 1000) * sampleRate);
}

/**
 * Calculate the duration for a given number of samples.
 *
 * @param samples - Number of samples
 * @param sampleRate - Sample rate in Hz
 * @returns Duration in milliseconds
 */
export function samplesToDuration(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

/**
 * Calculate the number of frames for a given duration.
 *
 * @param durationMs - Duration in milliseconds
 * @param model - VAD model type
 * @param sampleRate - Sample rate in Hz
 * @returns Number of frames
 */
export function durationToFrames(
  durationMs: number,
  model: VADModel,
  sampleRate: number
): number {
  const frameSize = getFrameSamplesForModel(model);
  const frameDurationMs = (frameSize / sampleRate) * 1000;
  return Math.ceil(durationMs / frameDurationMs);
}

/**
 * Calculate the duration for a given number of frames.
 *
 * @param frames - Number of frames
 * @param model - VAD model type
 * @param sampleRate - Sample rate in Hz
 * @returns Duration in milliseconds
 */
export function framesToDuration(
  frames: number,
  model: VADModel,
  sampleRate: number
): number {
  const frameSize = getFrameSamplesForModel(model);
  const frameDurationMs = (frameSize / sampleRate) * 1000;
  return frames * frameDurationMs;
}
