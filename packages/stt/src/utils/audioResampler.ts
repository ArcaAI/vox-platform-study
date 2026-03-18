/**
 * @arcaai/stt - Audio Resampler
 *
 * Utilities for resampling audio to 16kHz mono for Whisper processing.
 * Core resampling is delegated to @arcaai/room's resampleAudio.
 */

import { resampleAudio } from '@arcaai/room';

/**
 * Target sample rate for Whisper models.
 */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Resample audio using linear interpolation.
 * Delegates to @arcaai/room's resampleAudio.
 *
 * @param inputSamples - Input audio samples
 * @param inputSampleRate - Sample rate of input audio
 * @param outputSampleRate - Desired output sample rate
 * @returns Resampled audio samples
 */
export function resampleLinear(
  inputSamples: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  return resampleAudio(inputSamples, inputSampleRate, outputSampleRate);
}

/**
 * Convert stereo audio to mono by averaging channels.
 *
 * @param leftChannel - Left channel samples
 * @param rightChannel - Right channel samples
 * @returns Mono audio samples
 */
export function stereoToMono(
  leftChannel: Float32Array,
  rightChannel: Float32Array
): Float32Array {
  const length = Math.min(leftChannel.length, rightChannel.length);
  const mono = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    mono[i] = (leftChannel[i]! + rightChannel[i]!) / 2;
  }

  return mono;
}

/**
 * Convert multi-channel audio to mono by averaging all channels.
 *
 * @param channels - Array of channel data
 * @returns Mono audio samples
 */
export function multiChannelToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(0);
  }

  if (channels.length === 1) {
    return channels[0]!;
  }

  const length = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(length);
  const numChannels = channels.length;

  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += channels[ch]![i]!;
    }
    mono[i] = sum / numChannels;
  }

  return mono;
}

/**
 * Prepare audio for Whisper processing.
 * Converts to 16kHz mono Float32Array.
 *
 * @param audioBuffer - Web Audio API AudioBuffer
 * @returns Audio samples ready for Whisper (16kHz mono)
 */
export function prepareAudioForWhisper(audioBuffer: AudioBuffer): Float32Array {
  const inputSampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;

  let monoAudio: Float32Array;
  if (numChannels === 1) {
    monoAudio = audioBuffer.getChannelData(0);
  } else {
    const channels: Float32Array[] = [];
    for (let i = 0; i < numChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }
    monoAudio = multiChannelToMono(channels);
  }

  if (inputSampleRate !== WHISPER_SAMPLE_RATE) {
    return resampleLinear(monoAudio, inputSampleRate, WHISPER_SAMPLE_RATE);
  }

  return monoAudio;
}

/**
 * Prepare Float32Array audio for Whisper processing.
 *
 * @param samples - Input audio samples
 * @param sampleRate - Sample rate of input audio
 * @returns Audio samples ready for Whisper (16kHz)
 */
export function prepareFloat32ForWhisper(
  samples: Float32Array,
  sampleRate: number
): Float32Array {
  if (sampleRate === WHISPER_SAMPLE_RATE) {
    return samples;
  }
  return resampleLinear(samples, sampleRate, WHISPER_SAMPLE_RATE);
}

/**
 * Convert Int16 PCM audio to Float32.
 *
 * @param pcmData - Int16 PCM audio data
 * @returns Float32 audio samples normalized to [-1, 1]
 */
export function int16ToFloat32(pcmData: Int16Array): Float32Array {
  const float32 = new Float32Array(pcmData.length);
  for (let i = 0; i < pcmData.length; i++) {
    float32[i] = pcmData[i]! / 32768.0;
  }
  return float32;
}

/**
 * Convert Float32 audio to Int16 PCM.
 *
 * @param float32Data - Float32 audio samples
 * @returns Int16 PCM audio data
 */
export function float32ToInt16(float32Data: Float32Array): Int16Array {
  const int16 = new Int16Array(float32Data.length);
  for (let i = 0; i < float32Data.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Data[i]!));
    int16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return int16;
}

/**
 * Convert bytes to Float32Array (assuming 16-bit PCM little-endian).
 *
 * @param bytes - Raw audio bytes
 * @returns Float32 audio samples
 */
export function bytesToFloat32(bytes: ArrayBuffer | Uint8Array): Float32Array {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  const int16 = new Int16Array(buffer);
  return int16ToFloat32(int16);
}

/**
 * Convert Float32Array to bytes (16-bit PCM little-endian).
 *
 * @param samples - Float32 audio samples
 * @returns Raw audio bytes
 */
export function float32ToBytes(samples: Float32Array): Uint8Array {
  const int16 = float32ToInt16(samples);
  return new Uint8Array(int16.buffer);
}

/**
 * Calculate the duration in seconds for a given number of samples.
 *
 * @param sampleCount - Number of audio samples
 * @param sampleRate - Sample rate
 * @returns Duration in seconds
 */
export function samplesToDuration(
  sampleCount: number,
  sampleRate: number
): number {
  return sampleCount / sampleRate;
}

/**
 * Calculate the number of samples for a given duration.
 *
 * @param durationS - Duration in seconds
 * @param sampleRate - Sample rate
 * @returns Number of samples
 */
export function durationToSamples(
  durationS: number,
  sampleRate: number
): number {
  return Math.floor(durationS * sampleRate);
}

/**
 * Options for audio normalization.
 */
export interface NormalizeOptions {
  /**
   * Target peak level (0-1).
   * @default 0.95
   */
  targetPeak?: number;

  /**
   * Whether to apply DC offset removal.
   * @default true
   */
  removeDCOffset?: boolean;
}

/**
 * Normalize audio to a target peak level.
 *
 * @param samples - Input audio samples
 * @param options - Normalization options
 * @returns Normalized audio samples
 */
export function normalizeAudio(
  samples: Float32Array,
  options: NormalizeOptions = {}
): Float32Array {
  const { targetPeak = 0.95, removeDCOffset = true } = options;

  const output = new Float32Array(samples.length);

  let dcOffset = 0;
  if (removeDCOffset) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i]!;
    }
    dcOffset = sum / samples.length;
  }

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]! - dcOffset);
    if (value > peak) {
      peak = value;
    }
  }

  const gain = peak > 0 ? targetPeak / peak : 1;
  for (let i = 0; i < samples.length; i++) {
    output[i] = (samples[i]! - dcOffset) * gain;
  }

  return output;
}

/**
 * Concatenate multiple Float32Arrays.
 *
 * @param arrays - Arrays to concatenate
 * @returns Concatenated array
 */
export function concatenateFloat32Arrays(
  arrays: Float32Array[]
): Float32Array {
  if (arrays.length === 0) {
    return new Float32Array(0);
  }

  if (arrays.length === 1) {
    return arrays[0]!;
  }

  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Float32Array(totalLength);

  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}
