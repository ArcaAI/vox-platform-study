/**
 * @arcaai/stt - Audio Resampler Tests
 *
 * Comprehensive tests for audio resampling utilities.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  WHISPER_SAMPLE_RATE,
  resampleLinear,
  resampleSinc,
  stereoToMono,
  multiChannelToMono,
  prepareFloat32ForWhisper,
  int16ToFloat32,
  float32ToInt16,
  bytesToFloat32,
  float32ToBytes,
  samplesToDuration,
  durationToSamples,
  normalizeAudio,
  concatenateFloat32Arrays,
} from '../utils/audioResampler.js';

describe('audioResampler utilities', () => {
  describe('WHISPER_SAMPLE_RATE', () => {
    it('should be 16000', () => {
      expect(WHISPER_SAMPLE_RATE).toBe(16000);
    });
  });

  describe('resampleLinear', () => {
    it('should return same array if sample rates match', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const result = resampleLinear(samples, 48000, 48000);
      expect(result).toBe(samples);
    });

    it('should downsample correctly', () => {
      // Create 48 samples at 48kHz (1ms)
      const samples = new Float32Array(48);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 48);
      }

      // Resample to 16kHz (should be 16 samples)
      const result = resampleLinear(samples, 48000, 16000);
      expect(result.length).toBe(16);
    });

    it('should upsample correctly', () => {
      // Create 16 samples at 16kHz (1ms)
      const samples = new Float32Array(16);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 16);
      }

      // Resample to 48kHz (should be 48 samples)
      const result = resampleLinear(samples, 16000, 48000);
      expect(result.length).toBe(48);
    });

    it('should interpolate values smoothly', () => {
      const samples = new Float32Array([0, 1, 0, 1]);
      const result = resampleLinear(samples, 4, 8);

      // Doubled length with interpolated values
      expect(result.length).toBe(8);
      expect(result[0]).toBeCloseTo(0, 2);
      expect(result[1]).toBeCloseTo(0.5, 2);
      expect(result[2]).toBeCloseTo(1, 2);
    });

    it('should handle empty array', () => {
      const samples = new Float32Array(0);
      const result = resampleLinear(samples, 48000, 16000);
      expect(result.length).toBe(0);
    });

    it('should preserve DC offset', () => {
      const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      const result = resampleLinear(samples, 4, 8);
      result.forEach((sample) => {
        expect(sample).toBeCloseTo(0.5, 5);
      });
    });
  });

  describe('stereoToMono', () => {
    it('should average left and right channels', () => {
      const left = new Float32Array([0.2, 0.4, 0.6, 0.8]);
      const right = new Float32Array([0.8, 0.6, 0.4, 0.2]);

      const result = stereoToMono(left, right);

      expect(result.length).toBe(4);
      expect(result[0]).toBeCloseTo(0.5, 5);
      expect(result[1]).toBeCloseTo(0.5, 5);
      expect(result[2]).toBeCloseTo(0.5, 5);
      expect(result[3]).toBeCloseTo(0.5, 5);
    });

    it('should handle channels of different lengths', () => {
      const left = new Float32Array([0.2, 0.4, 0.6, 0.8, 1.0]);
      const right = new Float32Array([0.8, 0.6, 0.4]);

      const result = stereoToMono(left, right);

      expect(result.length).toBe(3); // Uses minimum length
    });

    it('should handle empty channels', () => {
      const left = new Float32Array(0);
      const right = new Float32Array(0);

      const result = stereoToMono(left, right);

      expect(result.length).toBe(0);
    });

    it('should handle identical channels', () => {
      const left = new Float32Array([0.5, 0.5, 0.5]);
      const right = new Float32Array([0.5, 0.5, 0.5]);

      const result = stereoToMono(left, right);

      expect(result[0]).toBeCloseTo(0.5, 5);
      expect(result[1]).toBeCloseTo(0.5, 5);
      expect(result[2]).toBeCloseTo(0.5, 5);
    });
  });

  describe('multiChannelToMono', () => {
    it('should return empty array for no channels', () => {
      const result = multiChannelToMono([]);
      expect(result.length).toBe(0);
    });

    it('should return same array for single channel', () => {
      const channel = new Float32Array([0.1, 0.2, 0.3]);
      const result = multiChannelToMono([channel]);
      expect(result).toBe(channel);
    });

    it('should average two channels', () => {
      const ch1 = new Float32Array([0.2, 0.4, 0.6]);
      const ch2 = new Float32Array([0.8, 0.6, 0.4]);

      const result = multiChannelToMono([ch1, ch2]);

      expect(result.length).toBe(3);
      expect(result[0]).toBeCloseTo(0.5, 5);
      expect(result[1]).toBeCloseTo(0.5, 5);
      expect(result[2]).toBeCloseTo(0.5, 5);
    });

    it('should average multiple channels', () => {
      const ch1 = new Float32Array([0.3, 0.6, 0.9]);
      const ch2 = new Float32Array([0.6, 0.3, 0.0]);
      const ch3 = new Float32Array([0.0, 0.0, 0.0]);

      const result = multiChannelToMono([ch1, ch2, ch3]);

      expect(result.length).toBe(3);
      expect(result[0]).toBeCloseTo(0.3, 5);
      expect(result[1]).toBeCloseTo(0.3, 5);
      expect(result[2]).toBeCloseTo(0.3, 5);
    });

    it('should use minimum channel length', () => {
      const ch1 = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const ch2 = new Float32Array([0.1, 0.2, 0.3]);

      const result = multiChannelToMono([ch1, ch2]);

      expect(result.length).toBe(3);
    });
  });

  describe('prepareFloat32ForWhisper', () => {
    it('should return same array if already at 16kHz', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3]);
      const result = prepareFloat32ForWhisper(samples, 16000);
      expect(result).toBe(samples);
    });

    it('should resample from 48kHz to 16kHz', () => {
      const samples = new Float32Array(48);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 48);
      }

      const result = prepareFloat32ForWhisper(samples, 48000);
      expect(result.length).toBe(16);
    });

    it('should resample from 44.1kHz to 16kHz', () => {
      const samples = new Float32Array(4410);
      const result = prepareFloat32ForWhisper(samples, 44100);
      expect(result.length).toBe(1600);
    });
  });

  describe('int16ToFloat32', () => {
    it('should convert Int16 to Float32', () => {
      const int16 = new Int16Array([0, 16384, -16384, 32767, -32768]);
      const result = int16ToFloat32(int16);

      expect(result.length).toBe(5);
      expect(result[0]).toBeCloseTo(0, 5);
      expect(result[1]).toBeCloseTo(0.5, 2);
      expect(result[2]).toBeCloseTo(-0.5, 2);
      expect(result[3]).toBeCloseTo(1, 2);
      expect(result[4]).toBe(-1);
    });

    it('should handle empty array', () => {
      const result = int16ToFloat32(new Int16Array(0));
      expect(result.length).toBe(0);
    });
  });

  describe('float32ToInt16', () => {
    it('should convert Float32 to Int16', () => {
      const float32 = new Float32Array([0, 0.5, -0.5, 1, -1]);
      const result = float32ToInt16(float32);

      expect(result.length).toBe(5);
      expect(result[0]).toBe(0);
      expect(result[1]).toBeCloseTo(16384, -2);
      expect(result[2]).toBeCloseTo(-16384, -2);
      expect(result[3]).toBe(32767);
      expect(result[4]).toBe(-32768);
    });

    it('should clamp values outside [-1, 1]', () => {
      const float32 = new Float32Array([2.0, -2.0, 1.5, -1.5]);
      const result = float32ToInt16(float32);

      expect(result[0]).toBe(32767);
      expect(result[1]).toBe(-32768);
      expect(result[2]).toBe(32767);
      expect(result[3]).toBe(-32768);
    });

    it('should handle empty array', () => {
      const result = float32ToInt16(new Float32Array(0));
      expect(result.length).toBe(0);
    });
  });

  describe('bytesToFloat32', () => {
    it('should convert bytes to Float32', () => {
      // Create Int16 data and get its bytes
      const int16 = new Int16Array([0, 16384, -16384]);
      const bytes = new Uint8Array(int16.buffer);

      const result = bytesToFloat32(bytes);

      expect(result.length).toBe(3);
      expect(result[0]).toBeCloseTo(0, 5);
      expect(result[1]).toBeCloseTo(0.5, 2);
      expect(result[2]).toBeCloseTo(-0.5, 2);
    });

    it('should handle ArrayBuffer input', () => {
      const int16 = new Int16Array([0, 16384]);
      const result = bytesToFloat32(int16.buffer);

      expect(result.length).toBe(2);
    });
  });

  describe('float32ToBytes', () => {
    it('should convert Float32 to bytes', () => {
      const float32 = new Float32Array([0, 0.5, -0.5]);
      const result = float32ToBytes(float32);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(6); // 3 samples * 2 bytes each
    });

    it('should be reversible with bytesToFloat32', () => {
      const original = new Float32Array([0, 0.5, -0.5, 1, -1]);
      const bytes = float32ToBytes(original);
      const restored = bytesToFloat32(bytes);

      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 2);
      }
    });
  });

  describe('samplesToDuration', () => {
    it('should calculate duration in seconds', () => {
      expect(samplesToDuration(16000, 16000)).toBe(1);
      expect(samplesToDuration(8000, 16000)).toBe(0.5);
      expect(samplesToDuration(48000, 48000)).toBe(1);
    });

    it('should handle zero samples', () => {
      expect(samplesToDuration(0, 16000)).toBe(0);
    });

    it('should handle different sample rates', () => {
      expect(samplesToDuration(44100, 44100)).toBe(1);
      expect(samplesToDuration(22050, 44100)).toBe(0.5);
    });
  });

  describe('durationToSamples', () => {
    it('should calculate number of samples', () => {
      expect(durationToSamples(1, 16000)).toBe(16000);
      expect(durationToSamples(0.5, 16000)).toBe(8000);
      expect(durationToSamples(1, 48000)).toBe(48000);
    });

    it('should handle zero duration', () => {
      expect(durationToSamples(0, 16000)).toBe(0);
    });

    it('should floor result', () => {
      expect(durationToSamples(0.3, 16000)).toBe(4800);
      expect(durationToSamples(0.33, 16000)).toBe(5280);
    });
  });

  describe('normalizeAudio', () => {
    it('should normalize to target peak', () => {
      const samples = new Float32Array([0.25, -0.25, 0.5, -0.5]);
      const result = normalizeAudio(samples, { targetPeak: 0.95 });

      const peak = Math.max(...result.map(Math.abs));
      expect(peak).toBeCloseTo(0.95, 2);
    });

    it('should remove DC offset', () => {
      const samples = new Float32Array([0.6, 0.7, 0.5, 0.6]);
      const result = normalizeAudio(samples, { removeDCOffset: true });

      // Average should be close to 0
      const average = result.reduce((a, b) => a + b, 0) / result.length;
      expect(Math.abs(average)).toBeLessThan(0.1);
    });

    it('should not remove DC offset when disabled', () => {
      const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      const result = normalizeAudio(samples, {
        removeDCOffset: false,
        targetPeak: 0.95,
      });

      // All samples should still be positive (offset preserved, just scaled)
      result.forEach((sample) => {
        expect(sample).toBeGreaterThanOrEqual(0);
      });
    });

    it('should use default options', () => {
      const samples = new Float32Array([0.5, -0.5, 0.25, -0.25]);
      const result = normalizeAudio(samples);

      const peak = Math.max(...result.map(Math.abs));
      expect(peak).toBeCloseTo(0.95, 2);
    });

    it('should handle silent audio', () => {
      const samples = new Float32Array([0, 0, 0, 0]);
      const result = normalizeAudio(samples);

      result.forEach((sample) => {
        expect(sample).toBe(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Anti-aliased downsampling on the Whisper capture path.
  // Linear interpolation aliases high-frequency content into the speech band;
  // the capture path must attenuate folded aliases by ≥ 40 dB relative to the
  // linear baseline while keeping the passband within 1 dB.
  // -------------------------------------------------------------------------
  describe('anti-aliased Whisper resampling', () => {
    function makeTone(freqHz: number, sampleRate: number, numSamples: number): Float32Array {
      const tone = new Float32Array(numSamples);
      const w = (2 * Math.PI * freqHz) / sampleRate;
      for (let i = 0; i < numSamples; i++) {
        tone[i] = Math.sin(w * i);
      }
      return tone;
    }

    /**
     * Goertzel single-bin probe returning the amplitude of a real sinusoid at
     * freqHz. The probe window must hold an integer number of cycles of
     * freqHz so the rectangular window causes no spectral leakage.
     */
    function goertzelAmplitude(samples: Float32Array, freqHz: number, sampleRate: number, start: number, length: number): number {
      const bin = Math.round((freqHz * length) / sampleRate);
      const w = (2 * Math.PI * bin) / length;
      const cosW = Math.cos(w);
      const coeff = 2 * cosW;
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < length; i++) {
        const s0 = samples[start + i]! + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const real = s1 - s2 * cosW;
      const imag = s2 * Math.sin(w);
      return (2 * Math.hypot(real, imag)) / length;
    }

    function toDb(amplitude: number): number {
      return 20 * Math.log10(Math.max(amplitude, 1e-12));
    }

    // Probe window: 4096 samples starting 2048 samples in — clear of filter
    // edge transients, and holds integer cycle counts at 16 kHz for both the
    // 1 kHz (256 cycles) and 6 kHz (1536 cycles) probes.
    const PROBE_START = 2048;
    const PROBE_LENGTH = 4096;

    it('attenuates the folded alias of a 10 kHz tone (48 kHz capture) by ≥ 40 dB vs the linear baseline', () => {
      // 0.5 s of a 10 kHz tone at 48 kHz. Decimating 48 kHz → 16 kHz folds
      // 10 kHz to |10k − 16k| = 6 kHz inside the output band.
      const input = makeTone(10_000, 48_000, 24_000);

      const linear = resampleLinear(input, 48_000, WHISPER_SAMPLE_RATE);
      const whisper = prepareFloat32ForWhisper(input, 48_000);
      expect(whisper.length).toBe(8000);

      const linearAliasDb = toDb(goertzelAmplitude(linear, 6_000, WHISPER_SAMPLE_RATE, PROBE_START, PROBE_LENGTH));
      const whisperAliasDb = toDb(goertzelAmplitude(whisper, 6_000, WHISPER_SAMPLE_RATE, PROBE_START, PROBE_LENGTH));

      // Linear interpolation leaves the folded alias essentially untouched
      // (~0 dBFS at an integer decimation ratio); the anti-aliased path must
      // push it down by at least 40 dB relative to that baseline.
      expect(linearAliasDb - whisperAliasDb).toBeGreaterThanOrEqual(40);
    });

    it('attenuates the folded alias of a 10 kHz tone (44.1 kHz capture, rational ratio) by ≥ 40 dB vs the linear baseline', () => {
      const input = makeTone(10_000, 44_100, 22_050);

      const linear = resampleLinear(input, 44_100, WHISPER_SAMPLE_RATE);
      const whisper = prepareFloat32ForWhisper(input, 44_100);
      expect(whisper.length).toBe(8000);

      const linearAliasDb = toDb(goertzelAmplitude(linear, 6_000, WHISPER_SAMPLE_RATE, PROBE_START, PROBE_LENGTH));
      const whisperAliasDb = toDb(goertzelAmplitude(whisper, 6_000, WHISPER_SAMPLE_RATE, PROBE_START, PROBE_LENGTH));

      expect(linearAliasDb - whisperAliasDb).toBeGreaterThanOrEqual(40);
    });

    it('keeps a 1 kHz tone within 1 dB through the 48 kHz → 16 kHz path', () => {
      const input = makeTone(1_000, 48_000, 24_000);
      const whisper = prepareFloat32ForWhisper(input, 48_000);

      const amplitude = goertzelAmplitude(whisper, 1_000, WHISPER_SAMPLE_RATE, PROBE_START, PROBE_LENGTH);
      expect(Math.abs(toDb(amplitude))).toBeLessThan(1);
    });

    it('keeps a 1 kHz tone within 1 dB through the 44.1 kHz → 16 kHz path', () => {
      const input = makeTone(1_000, 44_100, 22_050);
      const whisper = prepareFloat32ForWhisper(input, 44_100);

      const amplitude = goertzelAmplitude(whisper, 1_000, WHISPER_SAMPLE_RATE, PROBE_START, PROBE_LENGTH);
      expect(Math.abs(toDb(amplitude))).toBeLessThan(1);
    });
  });

  describe('resampleSinc', () => {
    it('should return the same array if sample rates match', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const result = resampleSinc(samples, 48000, 48000);
      expect(result).toBe(samples);
    });

    it('should match the linear resampler length semantics when downsampling', () => {
      const samples = new Float32Array(48);
      const result = resampleSinc(samples, 48000, 16000);
      expect(result.length).toBe(16);
    });

    it('should match the linear resampler length semantics for rational ratios', () => {
      const samples = new Float32Array(4410);
      const result = resampleSinc(samples, 44100, 16000);
      expect(result.length).toBe(1600);
    });

    it('should upsample to the expected length', () => {
      const samples = new Float32Array(16);
      const result = resampleSinc(samples, 16000, 48000);
      expect(result.length).toBe(48);
    });

    it('should handle empty input', () => {
      const result = resampleSinc(new Float32Array(0), 48000, 16000);
      expect(result.length).toBe(0);
    });

    it('should preserve DC offset away from the buffer edges', () => {
      const samples = new Float32Array(4800).fill(0.5);
      const result = resampleSinc(samples, 48000, 16000);

      // The kernel spans ~97 input samples, so only outputs near the edges
      // see zero-padding; the interior must carry the exact DC level.
      for (let i = 32; i < result.length - 32; i++) {
        expect(result[i]).toBeCloseTo(0.5, 5);
      }
    });

    it('should preserve DC through the direct-evaluation fallback for awkward rate pairs', () => {
      // 48000 → 15999 reduces to 16000/5333 — too many polyphase branches,
      // so the direct windowed-sinc path is used.
      const samples = new Float32Array(4800).fill(0.5);
      const result = resampleSinc(samples, 48000, 15999);

      expect(result.length).toBe(Math.round((4800 * 15999) / 48000));
      for (let i = 32; i < result.length - 32; i++) {
        expect(result[i]).toBeCloseTo(0.5, 4);
      }
    });
  });

  describe('concatenateFloat32Arrays', () => {
    it('should return empty array for no inputs', () => {
      const result = concatenateFloat32Arrays([]);
      expect(result.length).toBe(0);
    });

    it('should return same array for single input', () => {
      const arr = new Float32Array([0.1, 0.2, 0.3]);
      const result = concatenateFloat32Arrays([arr]);
      expect(result).toBe(arr);
    });

    it('should concatenate two arrays', () => {
      const arr1 = new Float32Array([0.1, 0.2, 0.3]);
      const arr2 = new Float32Array([0.4, 0.5]);

      const result = concatenateFloat32Arrays([arr1, arr2]);

      expect(result.length).toBe(5);
      expect(result[0]).toBeCloseTo(0.1, 5);
      expect(result[1]).toBeCloseTo(0.2, 5);
      expect(result[2]).toBeCloseTo(0.3, 5);
      expect(result[3]).toBeCloseTo(0.4, 5);
      expect(result[4]).toBeCloseTo(0.5, 5);
    });

    it('should concatenate multiple arrays', () => {
      const arr1 = new Float32Array([0.1]);
      const arr2 = new Float32Array([0.2]);
      const arr3 = new Float32Array([0.3]);
      const arr4 = new Float32Array([0.4]);

      const result = concatenateFloat32Arrays([arr1, arr2, arr3, arr4]);

      expect(result.length).toBe(4);
      expect(result[0]).toBeCloseTo(0.1, 5);
      expect(result[1]).toBeCloseTo(0.2, 5);
      expect(result[2]).toBeCloseTo(0.3, 5);
      expect(result[3]).toBeCloseTo(0.4, 5);
    });

    it('should handle arrays with empty arrays', () => {
      const arr1 = new Float32Array([0.1, 0.2]);
      const arr2 = new Float32Array(0);
      const arr3 = new Float32Array([0.3]);

      const result = concatenateFloat32Arrays([arr1, arr2, arr3]);

      expect(result.length).toBe(3);
    });
  });
});
