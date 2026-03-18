/**
 * @arcaai/room - Audio Utilities Tests
 *
 * Comprehensive tests for audio processing utility functions.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateRMSLevel,
  calculatePeakLevel,
  linearToDecibels,
  decibelsToLinear,
  detectVoiceActivity,
  createSmoothingCalculator,
  createSilenceDetector,
  resampleAudio,
  sleep,
} from '../utils/audioUtils.js';

describe('audioUtils', () => {
  describe('calculateRMSLevel', () => {
    it('should return 0 for empty array', () => {
      expect(calculateRMSLevel(new Float32Array(0))).toBe(0);
    });

    it('should return 0 for all-zero samples', () => {
      const samples = new Float32Array([0, 0, 0, 0, 0]);
      expect(calculateRMSLevel(samples)).toBe(0);
    });

    it('should calculate RMS for constant amplitude', () => {
      const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      expect(calculateRMSLevel(samples)).toBeCloseTo(0.5, 5);
    });

    it('should calculate RMS for varying amplitudes', () => {
      // RMS of [1, -1, 1, -1] = sqrt((1+1+1+1)/4) = 1
      const samples = new Float32Array([1, -1, 1, -1]);
      expect(calculateRMSLevel(samples)).toBeCloseTo(1, 5);
    });

    it('should calculate RMS for sine-like wave', () => {
      // For a sine wave, RMS = amplitude / sqrt(2)
      const amplitude = 0.5;
      const samples = new Float32Array(1000);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = amplitude * Math.sin((2 * Math.PI * i) / samples.length);
      }
      const expectedRMS = amplitude / Math.sqrt(2);
      expect(calculateRMSLevel(samples)).toBeCloseTo(expectedRMS, 2);
    });

    it('should handle negative values correctly', () => {
      const samples = new Float32Array([-0.5, -0.5, -0.5, -0.5]);
      expect(calculateRMSLevel(samples)).toBeCloseTo(0.5, 5);
    });
  });

  describe('calculatePeakLevel', () => {
    it('should return 0 for empty array', () => {
      expect(calculatePeakLevel(new Float32Array(0))).toBe(0);
    });

    it('should return 0 for all-zero samples', () => {
      const samples = new Float32Array([0, 0, 0, 0, 0]);
      expect(calculatePeakLevel(samples)).toBe(0);
    });

    it('should find positive peak', () => {
      const samples = new Float32Array([0.1, 0.5, 0.3, 0.2]);
      expect(calculatePeakLevel(samples)).toBe(0.5);
    });

    it('should find negative peak (absolute value)', () => {
      const samples = new Float32Array([0.1, -0.7, 0.3, 0.2]);
      expect(calculatePeakLevel(samples)).toBeCloseTo(0.7, 5);
    });

    it('should handle full-scale signal', () => {
      const samples = new Float32Array([0.5, 1.0, -0.8, 0.3]);
      expect(calculatePeakLevel(samples)).toBe(1.0);
    });

    it('should handle all negative values', () => {
      const samples = new Float32Array([-0.1, -0.5, -0.3, -0.2]);
      expect(calculatePeakLevel(samples)).toBe(0.5);
    });
  });

  describe('linearToDecibels', () => {
    it('should return -Infinity for zero amplitude', () => {
      expect(linearToDecibels(0)).toBe(-Infinity);
    });

    it('should return -Infinity for negative amplitude', () => {
      expect(linearToDecibels(-1)).toBe(-Infinity);
    });

    it('should return 0 dB for unity amplitude', () => {
      expect(linearToDecibels(1)).toBeCloseTo(0, 5);
    });

    it('should calculate -6 dB for half amplitude', () => {
      expect(linearToDecibels(0.5)).toBeCloseTo(-6.02, 1);
    });

    it('should calculate -20 dB for 0.1 amplitude', () => {
      expect(linearToDecibels(0.1)).toBeCloseTo(-20, 1);
    });

    it('should calculate +6 dB for 2x amplitude', () => {
      expect(linearToDecibels(2)).toBeCloseTo(6.02, 1);
    });
  });

  describe('decibelsToLinear', () => {
    it('should return 1 for 0 dB', () => {
      expect(decibelsToLinear(0)).toBeCloseTo(1, 5);
    });

    it('should return ~0.5 for -6 dB', () => {
      expect(decibelsToLinear(-6.02)).toBeCloseTo(0.5, 2);
    });

    it('should return ~0.1 for -20 dB', () => {
      expect(decibelsToLinear(-20)).toBeCloseTo(0.1, 2);
    });

    it('should return ~2 for +6 dB', () => {
      expect(decibelsToLinear(6.02)).toBeCloseTo(2, 1);
    });

    it('should be inverse of linearToDecibels', () => {
      const amplitude = 0.7;
      const db = linearToDecibels(amplitude);
      const result = decibelsToLinear(db);
      expect(result).toBeCloseTo(amplitude, 5);
    });
  });

  describe('detectVoiceActivity', () => {
    it('should return false for zero level', () => {
      expect(detectVoiceActivity(0)).toBe(false);
    });

    it('should return false for level below threshold', () => {
      expect(detectVoiceActivity(0.005)).toBe(false);
      expect(detectVoiceActivity(0.009)).toBe(false);
    });

    it('should return true for level above threshold', () => {
      expect(detectVoiceActivity(0.02)).toBe(true);
      expect(detectVoiceActivity(0.1)).toBe(true);
    });

    it('should respect custom threshold', () => {
      expect(detectVoiceActivity(0.05, 0.1)).toBe(false);
      expect(detectVoiceActivity(0.15, 0.1)).toBe(true);
    });

    it('should return false for level exactly at threshold', () => {
      expect(detectVoiceActivity(0.01, 0.01)).toBe(false);
    });
  });

  describe('createSmoothingCalculator', () => {
    it('should smooth level changes', () => {
      const smooth = createSmoothingCalculator(0.8);

      // First call establishes baseline
      const result1 = smooth(1.0);
      expect(result1).toBeCloseTo(0.2, 5); // (1 - 0.8) * 1.0

      // Second call smooths further
      const result2 = smooth(1.0);
      expect(result2).toBeCloseTo(0.36, 5); // 0.8 * 0.2 + 0.2 * 1.0
    });

    it('should converge to constant input', () => {
      const smooth = createSmoothingCalculator(0.8);

      let result = 0;
      for (let i = 0; i < 100; i++) {
        result = smooth(0.5);
      }

      expect(result).toBeCloseTo(0.5, 2);
    });

    it('should respond slowly to changes with high smoothing', () => {
      const smooth = createSmoothingCalculator(0.95);

      smooth(0); // Initialize at 0
      const result = smooth(1.0);

      // With 0.95 smoothing, response to sudden change is small
      expect(result).toBeLessThan(0.1);
    });

    it('should respond quickly with low smoothing', () => {
      const smooth = createSmoothingCalculator(0.1);

      smooth(0); // Initialize at 0
      const result = smooth(1.0);

      // With 0.1 smoothing, response to sudden change is large
      expect(result).toBeGreaterThan(0.8);
    });
  });

  describe('createSilenceDetector', () => {
    it('should detect silence after threshold duration', () => {
      const detectSilence = createSilenceDetector({
        threshold: 0.001,
        duration: 100, // 100ms
        sampleRate: 48000,
      });

      // 100ms at 48kHz = 4800 samples
      const silentSamples = new Float32Array(4800).fill(0);

      // First call - not enough silent samples yet
      expect(detectSilence(silentSamples)).toBe(true);
    });

    it('should not detect silence when audio is present', () => {
      const detectSilence = createSilenceDetector({
        threshold: 0.001,
        duration: 100,
        sampleRate: 48000,
      });

      const loudSamples = new Float32Array(4800).fill(0.5);
      expect(detectSilence(loudSamples)).toBe(false);
    });

    it('should reset silence counter when audio detected', () => {
      const detectSilence = createSilenceDetector({
        threshold: 0.001,
        duration: 100,
        sampleRate: 48000,
      });

      const silentSamples = new Float32Array(2400).fill(0);
      const loudSamples = new Float32Array(100).fill(0.5);

      detectSilence(silentSamples); // Accumulate some silence
      detectSilence(loudSamples); // Reset counter
      expect(detectSilence(silentSamples)).toBe(false); // Not enough accumulated
    });

    it('should use default options', () => {
      const detectSilence = createSilenceDetector();

      // Default is 1000ms at 48kHz = 48000 samples
      const shortSilence = new Float32Array(10000).fill(0);
      expect(detectSilence(shortSilence)).toBe(false);
    });
  });

  describe('resampleAudio', () => {
    it('should return same array if sample rates match', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const result = resampleAudio(samples, 48000, 48000);
      expect(result).toBe(samples);
    });

    it('should downsample correctly', () => {
      // Create 48 samples at 48kHz (1ms)
      const samples = new Float32Array(48);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 48);
      }

      // Resample to 16kHz (should be 16 samples)
      const result = resampleAudio(samples, 48000, 16000);
      expect(result.length).toBe(16);
    });

    it('should upsample correctly', () => {
      // Create 16 samples at 16kHz (1ms)
      const samples = new Float32Array(16);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 16);
      }

      // Resample to 48kHz (should be 48 samples)
      const result = resampleAudio(samples, 16000, 48000);
      expect(result.length).toBe(48);
    });

    it('should interpolate values', () => {
      const samples = new Float32Array([0, 1, 0, 1]);
      const result = resampleAudio(samples, 4, 8);

      // Doubled length with interpolated values
      expect(result.length).toBe(8);
      expect(result[0]).toBeCloseTo(0, 2);
      expect(result[1]).toBeCloseTo(0.5, 2);
      expect(result[2]).toBeCloseTo(1, 2);
    });

    it('should handle empty array', () => {
      const samples = new Float32Array(0);
      const result = resampleAudio(samples, 48000, 16000);
      expect(result.length).toBe(0);
    });
  });

  describe('sleep', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should resolve after specified duration', async () => {
      const callback = vi.fn();
      sleep(100).then(callback);

      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(callback).toHaveBeenCalled();
    });

    it('should return a promise', () => {
      const result = sleep(100);
      expect(result).toBeInstanceOf(Promise);
    });

    it('should work with await', async () => {
      const callback = vi.fn();

      const promise = sleep(500).then(callback);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await promise;

      expect(callback).toHaveBeenCalled();
    });
  });
});
