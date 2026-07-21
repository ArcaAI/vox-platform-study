/**
 * @arcaai/stt - Audio Resampler
 *
 * Utilities for resampling audio to 16kHz mono for Whisper processing.
 *
 * The Whisper capture path uses an anti-aliased Kaiser-windowed-sinc
 * polyphase resampler. The legacy linear-interpolation resampler (delegating
 * to @arcaai/room's resampleAudio) remains exported for backward
 * compatibility.
 */

import { resampleAudio } from '@arcaai/room';

/**
 * Target sample rate for Whisper models.
 */
export const WHISPER_SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------
// Windowed-sinc anti-aliased resampling
//
// Linear interpolation performs no low-pass filtering, so when downsampling
// (e.g. a 48 kHz capture to Whisper's 16 kHz) any content above the target
// Nyquist folds back into the speech band as aliasing, degrading consonant
// recognition. The polyphase decimator below low-passes at ~0.45× the target
// rate (7.2 kHz for 16 kHz output) with a Kaiser window before decimating.
// ---------------------------------------------------------------------------

/** Taps per polyphase branch — each output sample costs about this many MACs. */
const SINC_TAPS_PER_BRANCH = 32;

/** Kaiser window shape parameter (β = 9 → ≈90 dB design stopband attenuation). */
const KAISER_BETA = 9;

/** Low-pass cutoff as a fraction of the smaller of the two sample rates. */
const SINC_CUTOFF_RATIO = 0.45;

/** Above this many polyphase branches, fall back to direct kernel evaluation. */
const MAX_POLYPHASE_BRANCHES = 1024;

/** Maximum number of cached filter banks (rate pairs are stable per session). */
const SINC_BANK_CACHE_LIMIT = 8;

interface SincFilterBank {
  /** Interpolation factor — number of polyphase branches (toRate / gcd). */
  branches: number;
  /** Decimation step in the virtual upsampled domain (fromRate / gcd). */
  step: number;
  /** Offset of the prototype kernel centre in virtual samples. */
  center: number;
  /** Per-branch taps (unit DC gain); taps[r][j] weights input[anchor - j]. */
  taps: Float32Array[];
}

/** Cached filter banks keyed by `${fromRate}->${toRate}`. */
const sincBankCache = new Map<string, SincFilterBank>();

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Modified Bessel function of the first kind, order zero (power series). */
function besselI0(x: number): number {
  const quarterXSq = (x * x) / 4;
  let sum = 1;
  let term = 1;
  for (let k = 1; k <= 64; k++) {
    term *= quarterXSq / (k * k);
    sum += term;
    if (term < sum * 1e-12) {
      break;
    }
  }
  return sum;
}

function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Design a Kaiser-windowed-sinc polyphase filter bank for an integer rate
 * pair. The prototype low-pass is designed at the virtual upsampled rate
 * `fromRate × branches` with an odd tap count so the kernel centre falls on
 * an integer virtual sample.
 */
function designSincBank(fromRate: number, toRate: number): SincFilterBank {
  const divisor = gcd(fromRate, toRate);
  const branches = toRate / divisor;
  const step = fromRate / divisor;

  const protoLength = SINC_TAPS_PER_BRANCH * Math.max(branches, step) + 1;
  const center = (protoLength - 1) / 2;
  // Cutoff in cycles per virtual sample (0.45 × min Nyquist of the two rates).
  const cutoff = (SINC_CUTOFF_RATIO * Math.min(fromRate, toRate)) / (fromRate * branches);
  const i0Beta = besselI0(KAISER_BETA);

  const proto = new Float64Array(protoLength);
  for (let n = 0; n < protoLength; n++) {
    const t = n - center;
    const ratio = t / center;
    const window = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0Beta;
    proto[n] = window * 2 * cutoff * sinc(2 * cutoff * t);
  }

  // Polyphase split: branch r collects proto[r], proto[r + branches], …
  // Each branch is normalized to unit DC gain so constant signals (and the
  // passband level) survive identically for every output phase.
  const taps: Float32Array[] = [];
  for (let r = 0; r < branches; r++) {
    const branchLength = Math.ceil((protoLength - r) / branches);
    const branch = new Float32Array(branchLength);
    let sum = 0;
    for (let j = 0; j < branchLength; j++) {
      sum += proto[r + j * branches]!;
    }
    const gain = sum !== 0 ? 1 / sum : 1;
    for (let j = 0; j < branchLength; j++) {
      branch[j] = proto[r + j * branches]! * gain;
    }
    taps.push(branch);
  }

  return { branches, step, center, taps };
}

function getSincBank(fromRate: number, toRate: number): SincFilterBank {
  const key = `${fromRate}->${toRate}`;
  const cached = sincBankCache.get(key);
  if (cached) {
    return cached;
  }

  const bank = designSincBank(fromRate, toRate);
  if (sincBankCache.size >= SINC_BANK_CACHE_LIMIT) {
    // Safety valve only — real sessions use one or two rate pairs.
    const oldest = sincBankCache.keys().next().value;
    if (oldest !== undefined) {
      sincBankCache.delete(oldest);
    }
  }
  sincBankCache.set(key, bank);
  return bank;
}

function resampleWithBank(input: Float32Array, bank: SincFilterBank, outputLength: number): Float32Array {
  const { branches, step, center, taps } = bank;
  const output = new Float32Array(outputLength);
  const inputLength = input.length;

  for (let m = 0; m < outputLength; m++) {
    // Virtual-domain position of this output sample shifted by the kernel
    // centre; `anchor` is the newest input sample under the kernel, so the
    // output stays time-aligned with input position m × step / branches.
    const v = m * step + center;
    const anchor = Math.floor(v / branches);
    const branch = taps[v - anchor * branches]!;

    // Out-of-range input indices contribute zero (edge zero-padding).
    const jStart = anchor >= inputLength ? anchor - inputLength + 1 : 0;
    const jEnd = Math.min(branch.length, anchor + 1);
    let acc = 0;
    for (let j = jStart; j < jEnd; j++) {
      acc += branch[j]! * input[anchor - j]!;
    }
    output[m] = acc;
  }

  return output;
}

/**
 * Direct windowed-sinc evaluation for rate pairs that do not reduce to a
 * small rational ratio (e.g. non-integer rates). Slower than the polyphase
 * bank but handles arbitrary ratios; weights are renormalized per output
 * sample, which preserves DC gain even at the buffer edges.
 */
function resampleSincDirect(input: Float32Array, fromRate: number, toRate: number, outputLength: number): Float32Array {
  const ratio = fromRate / toRate;
  const halfSpan = (SINC_TAPS_PER_BRANCH / 2) * Math.max(1, ratio);
  const cutoff = (SINC_CUTOFF_RATIO * Math.min(fromRate, toRate)) / fromRate;
  const i0Beta = besselI0(KAISER_BETA);
  const output = new Float32Array(outputLength);

  for (let m = 0; m < outputLength; m++) {
    const position = m * ratio;
    const kStart = Math.max(0, Math.ceil(position - halfSpan));
    const kEnd = Math.min(input.length - 1, Math.floor(position + halfSpan));
    let acc = 0;
    let weightSum = 0;
    for (let k = kStart; k <= kEnd; k++) {
      const t = k - position;
      const x = t / halfSpan;
      const weight = (besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - x * x))) / i0Beta) * sinc(2 * cutoff * t);
      acc += weight * input[k]!;
      weightSum += weight;
    }
    output[m] = weightSum !== 0 ? acc / weightSum : 0;
  }

  return output;
}

/**
 * Resample audio with an anti-aliasing Kaiser-windowed-sinc polyphase filter.
 *
 * Unlike {@link resampleLinear}, this path low-passes the signal below the
 * target Nyquist before decimation (≈7.2 kHz cutoff for a 16 kHz target), so
 * high-frequency content is attenuated instead of folding back into the
 * speech band as aliasing. Integer rate pairs that reduce to a small rational
 * ratio use a cached polyphase filter bank (≈32–97 taps per output sample
 * depending on the ratio); other rate pairs fall back to direct windowed-sinc
 * evaluation.
 *
 * @param inputSamples - Input audio samples
 * @param inputSampleRate - Sample rate of input audio
 * @param outputSampleRate - Desired output sample rate
 * @returns Resampled audio samples (same array identity when rates match)
 */
export function resampleSinc(inputSamples: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return inputSamples;
  }

  const outputLength = Math.round((inputSamples.length * outputSampleRate) / inputSampleRate);
  if (outputLength <= 0) {
    return new Float32Array(0);
  }

  if (Number.isInteger(inputSampleRate) && Number.isInteger(outputSampleRate)) {
    const branches = outputSampleRate / gcd(inputSampleRate, outputSampleRate);
    if (branches <= MAX_POLYPHASE_BRANCHES) {
      return resampleWithBank(inputSamples, getSincBank(inputSampleRate, outputSampleRate), outputLength);
    }
  }

  return resampleSincDirect(inputSamples, inputSampleRate, outputSampleRate, outputLength);
}

/**
 * Resample audio using linear interpolation.
 * Delegates to @arcaai/room's resampleAudio.
 *
 * @param inputSamples - Input audio samples
 * @param inputSampleRate - Sample rate of input audio
 * @param outputSampleRate - Desired output sample rate
 * @returns Resampled audio samples
 */
export function resampleLinear(inputSamples: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
  return resampleAudio(inputSamples, inputSampleRate, outputSampleRate);
}

/**
 * Convert stereo audio to mono by averaging channels.
 *
 * @param leftChannel - Left channel samples
 * @param rightChannel - Right channel samples
 * @returns Mono audio samples
 */
export function stereoToMono(leftChannel: Float32Array, rightChannel: Float32Array): Float32Array {
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
    // Anti-aliased path (linear interpolation folded >8 kHz content into
    // the speech band and hurt Whisper consonant accuracy).
    return resampleSinc(monoAudio, inputSampleRate, WHISPER_SAMPLE_RATE);
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
export function prepareFloat32ForWhisper(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === WHISPER_SAMPLE_RATE) {
    return samples;
  }
  // Anti-aliased path (linear interpolation folded >8 kHz content into
  // the speech band and hurt Whisper consonant accuracy).
  return resampleSinc(samples, sampleRate, WHISPER_SAMPLE_RATE);
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
export function samplesToDuration(sampleCount: number, sampleRate: number): number {
  return sampleCount / sampleRate;
}

/**
 * Calculate the number of samples for a given duration.
 *
 * @param durationS - Duration in seconds
 * @param sampleRate - Sample rate
 * @returns Number of samples
 */
export function durationToSamples(durationS: number, sampleRate: number): number {
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
export function normalizeAudio(samples: Float32Array, options: NormalizeOptions = {}): Float32Array {
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
export function concatenateFloat32Arrays(arrays: Float32Array[]): Float32Array {
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
