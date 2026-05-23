/**
 * @arcaai/vad - Audio Resampler
 *
 * Utilities for resampling audio to the required sample rate (16kHz for Silero VAD).
 * Core resampling is delegated to @arcaai/room's resampleAudio.
 */

import { resampleAudio } from '@arcaai/room';

/**
 * Target sample rate for Silero VAD models.
 */
export const VAD_SAMPLE_RATE = 16000;

/**
 * Linear interpolation resampler.
 * Delegates to @arcaai/room's resampleAudio.
 *
 * @param inputSamples - Input audio samples
 * @param inputSampleRate - Sample rate of input audio
 * @param outputSampleRate - Target sample rate
 * @returns Resampled audio samples
 */
export function linearResample(inputSamples: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
  return resampleAudio(inputSamples, inputSampleRate, outputSampleRate);
}

/**
 * Resampler class for streaming audio resampling.
 * Maintains state for continuous resampling with proper sample tracking.
 * Uses @arcaai/room's resampleAudio for the core interpolation.
 */
export class Resampler {
  private inputSampleRate: number;
  private outputSampleRate: number;
  private ratio: number;
  private carryOver: Float32Array | null = null;

  /**
   * Create a new Resampler.
   *
   * @param inputSampleRate - Sample rate of input audio
   * @param outputSampleRate - Target sample rate (default: 16000 for VAD)
   */
  constructor(inputSampleRate: number, outputSampleRate: number = VAD_SAMPLE_RATE) {
    this.inputSampleRate = inputSampleRate;
    this.outputSampleRate = outputSampleRate;
    this.ratio = inputSampleRate / outputSampleRate;
  }

  /**
   * Resample a chunk of audio.
   *
   * @param samples - Input audio samples
   * @returns Resampled audio samples
   */
  process(samples: Float32Array): Float32Array {
    if (this.inputSampleRate === this.outputSampleRate) {
      return samples;
    }

    let inputSamples: Float32Array;
    if (this.carryOver && this.carryOver.length > 0) {
      inputSamples = new Float32Array(this.carryOver.length + samples.length);
      inputSamples.set(this.carryOver, 0);
      inputSamples.set(samples, this.carryOver.length);
      this.carryOver = null;
    } else {
      inputSamples = samples;
    }

    const result = resampleAudio(inputSamples, this.inputSampleRate, this.outputSampleRate);

    const usedInputSamples = Math.ceil(result.length * this.ratio);
    if (usedInputSamples < inputSamples.length) {
      this.carryOver = inputSamples.slice(usedInputSamples);
    }

    return result;
  }

  /**
   * Reset the resampler state.
   */
  reset(): void {
    this.carryOver = null;
  }

  /**
   * Get the resampling ratio.
   */
  getRatio(): number {
    return this.ratio;
  }

  /**
   * Get the input sample rate.
   */
  getInputSampleRate(): number {
    return this.inputSampleRate;
  }

  /**
   * Get the output sample rate.
   */
  getOutputSampleRate(): number {
    return this.outputSampleRate;
  }
}

/**
 * Downsample audio to 16kHz for VAD processing.
 *
 * @param samples - Input audio samples
 * @param sampleRate - Input sample rate
 * @returns Downsampled audio at 16kHz
 */
export function downsampleTo16kHz(samples: Float32Array, sampleRate: number): Float32Array {
  return linearResample(samples, sampleRate, VAD_SAMPLE_RATE);
}

/**
 * Upsample audio from 16kHz to target sample rate.
 *
 * @param samples - Input audio samples at 16kHz
 * @param targetSampleRate - Target sample rate
 * @returns Upsampled audio
 */
export function upsampleFrom16kHz(samples: Float32Array, targetSampleRate: number): Float32Array {
  return linearResample(samples, VAD_SAMPLE_RATE, targetSampleRate);
}

/**
 * Resample any input audio buffer to the Silero VAD's required 16 kHz.
 *
 * Returns the input untouched (same identity) when `inputSampleRate` is
 * already 16 kHz so callers can hot-path the common case without a
 * defensive `if`. For 44.1 / 48 kHz captures (the typical browser default
 * `AudioContext.sampleRate`) the helper produces a Float32Array of the
 * expected length using the project-wide `linearResample` implementation.
 *
 * Intended primarily for consumers building custom pipelines around
 * `VADProcessor`. The processor itself delegates real-time resampling to
 * `MicVAD`'s internal worklet, but callers that pre-buffer audio or run
 * non-real-time inference should funnel through this helper instead of
 * implementing their own conversion. (TASK-271 L-2.)
 *
 * @param samples - Input audio samples
 * @param inputSampleRate - Sample rate of the input samples
 * @returns The same buffer (when already 16 kHz) or a freshly resampled buffer
 */
export function resampleToVADRate(samples: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === VAD_SAMPLE_RATE) {
    return samples;
  }
  return linearResample(samples, inputSampleRate, VAD_SAMPLE_RATE);
}
