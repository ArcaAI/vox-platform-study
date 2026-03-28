/**
 * @arcaai/room - Audio Utilities
 *
 * Utility functions for audio processing and analysis.
 */

/**
 * Calculate RMS (Root Mean Square) level from audio samples.
 * Returns a value between 0 and 1.
 *
 * @param samples - Float32Array of audio samples
 * @returns RMS level (0-1)
 */
export function calculateRMSLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    sum += sample * sample;
  }

  return Math.sqrt(sum / samples.length);
}

/**
 * Calculate peak level from audio samples.
 * Returns the maximum absolute sample value (0-1).
 *
 * @param samples - Float32Array of audio samples
 * @returns Peak level (0-1)
 */
export function calculatePeakLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]!);
    if (abs > peak) {
      peak = abs;
    }
  }

  return peak;
}

/**
 * Convert linear amplitude to decibels.
 *
 * @param amplitude - Linear amplitude (0-1)
 * @returns Decibel value
 */
export function linearToDecibels(amplitude: number): number {
  if (amplitude <= 0) return -Infinity;
  return 20 * Math.log10(amplitude);
}

/**
 * Convert decibels to linear amplitude.
 *
 * @param db - Decibel value
 * @returns Linear amplitude (0-1)
 */
export function decibelsToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Simple voice activity detection based on RMS level.
 *
 * @param level - Current RMS level (0-1)
 * @param threshold - Threshold for voice detection (default: 0.01)
 * @returns Whether voice activity is detected
 */
export function detectVoiceActivity(level: number, threshold = 0.01): boolean {
  return level > threshold;
}

/**
 * Create a smoothed level calculator using exponential moving average.
 *
 * @param smoothingFactor - Smoothing factor (0-1, higher = more smoothing)
 * @returns Function to calculate smoothed level
 */
export function createSmoothingCalculator(smoothingFactor = 0.8) {
  let smoothedLevel = 0;

  return (currentLevel: number): number => {
    smoothedLevel = smoothingFactor * smoothedLevel + (1 - smoothingFactor) * currentLevel;
    return smoothedLevel;
  };
}

/**
 * Create a silence detector with configurable parameters.
 *
 * @param options - Silence detection options
 * @returns Silence detector function
 */
export function createSilenceDetector(
  options: {
    /** Threshold below which audio is considered silent */
    threshold?: number;
    /** Duration in ms before silence is confirmed */
    duration?: number;
    /** Sample rate for timing calculations */
    sampleRate?: number;
  } = {},
) {
  const { threshold = 0.001, duration = 1000, sampleRate = 48000 } = options;

  let silentSamples = 0;
  const silentSamplesThreshold = (duration / 1000) * sampleRate;

  return (samples: Float32Array): boolean => {
    const level = calculateRMSLevel(samples);

    if (level < threshold) {
      silentSamples += samples.length;
    } else {
      silentSamples = 0;
    }

    return silentSamples >= silentSamplesThreshold;
  };
}

/**
 * Resample audio data to a target sample rate.
 * Uses linear interpolation for simplicity.
 *
 * @param samples - Input audio samples
 * @param fromSampleRate - Source sample rate
 * @param toSampleRate - Target sample rate
 * @returns Resampled audio
 */
export function resampleAudio(samples: Float32Array, fromSampleRate: number, toSampleRate: number): Float32Array {
  if (fromSampleRate === toSampleRate) {
    return samples;
  }

  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const fraction = srcIndex - srcIndexFloor;

    result[i] = samples[srcIndexFloor]! * (1 - fraction) + samples[srcIndexCeil]! * fraction;
  }

  return result;
}

/**
 * Convert AudioBuffer to Float32Array (mono, first channel).
 *
 * @param buffer - AudioBuffer to convert
 * @returns Float32Array of samples
 */
export function audioBufferToFloat32(buffer: AudioBuffer): Float32Array {
  return buffer.getChannelData(0);
}

/**
 * Create a MediaStreamTrack from an AudioBuffer.
 *
 * @param buffer - AudioBuffer to convert
 * @param audioContext - AudioContext to use
 * @returns MediaStreamTrack
 */
export function audioBufferToTrack(buffer: AudioBuffer, audioContext: AudioContext): MediaStreamTrack {
  const source = audioContext.createBufferSource();
  source.buffer = buffer;

  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);
  source.start();

  return destination.stream.getAudioTracks()[0]!;
}

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
