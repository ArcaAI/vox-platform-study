/**
 * @arcaai/vad - Resampler Tests
 *
 * Comprehensive tests for audio resampling utilities.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  VAD_SAMPLE_RATE,
  linearResample,
  Resampler,
  downsampleTo16kHz,
  upsampleFrom16kHz,
  resampleToVADRate,
} from '../utils/resampler.js';

describe('resampler utilities', () => {
  describe('VAD_SAMPLE_RATE', () => {
    it('should be 16000', () => {
      expect(VAD_SAMPLE_RATE).toBe(16000);
    });
  });

  describe('linearResample', () => {
    it('should return same array if sample rates match', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const result = linearResample(samples, 48000, 48000);
      expect(result).toBe(samples);
    });

    it('should downsample 48kHz to 16kHz', () => {
      const samples = new Float32Array(48);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 48);
      }

      const result = linearResample(samples, 48000, 16000);
      expect(result.length).toBe(16);
    });

    it('should upsample 16kHz to 48kHz', () => {
      const samples = new Float32Array(16);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 16);
      }

      const result = linearResample(samples, 16000, 48000);
      expect(result.length).toBe(48);
    });

    it('should interpolate values', () => {
      const samples = new Float32Array([0, 1, 0, 1]);
      const result = linearResample(samples, 4, 8);

      expect(result.length).toBe(8);
      expect(result[0]).toBeCloseTo(0, 2);
      expect(result[1]).toBeCloseTo(0.5, 2);
      expect(result[2]).toBeCloseTo(1, 2);
    });

    it('should handle empty array', () => {
      const samples = new Float32Array(0);
      const result = linearResample(samples, 48000, 16000);
      expect(result.length).toBe(0);
    });

    it('should preserve DC offset', () => {
      const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      const result = linearResample(samples, 4, 8);
      result.forEach((sample) => {
        expect(sample).toBeCloseTo(0.5, 5);
      });
    });

    it('should handle 44.1kHz to 16kHz conversion', () => {
      const samples = new Float32Array(441);
      const result = linearResample(samples, 44100, 16000);
      expect(result.length).toBe(160);
    });
  });

  describe('Resampler class', () => {
    describe('constructor', () => {
      it('should create resampler with given sample rates', () => {
        const resampler = new Resampler(48000, 16000);
        expect(resampler.getInputSampleRate()).toBe(48000);
        expect(resampler.getOutputSampleRate()).toBe(16000);
      });

      it('should default to VAD_SAMPLE_RATE for output', () => {
        const resampler = new Resampler(48000);
        expect(resampler.getOutputSampleRate()).toBe(16000);
      });

      it('should calculate correct ratio', () => {
        const resampler = new Resampler(48000, 16000);
        expect(resampler.getRatio()).toBe(3);
      });
    });

    describe('process', () => {
      it('should return same array if sample rates match', () => {
        const resampler = new Resampler(16000, 16000);
        const samples = new Float32Array([0.1, 0.2, 0.3]);
        const result = resampler.process(samples);
        expect(result).toBe(samples);
      });

      it('should resample audio correctly', () => {
        const resampler = new Resampler(48000, 16000);
        const samples = new Float32Array(48);

        const result = resampler.process(samples);
        expect(result.length).toBe(16);
      });

      it('should handle streaming with carry-over', () => {
        const resampler = new Resampler(48000, 16000);

        // Process first chunk
        const chunk1 = new Float32Array(128);
        const result1 = resampler.process(chunk1);

        // Process second chunk
        const chunk2 = new Float32Array(128);
        const result2 = resampler.process(chunk2);

        // Total output should be approximately total input / 3
        const totalOutput = result1.length + result2.length;
        expect(totalOutput).toBeGreaterThan(80);
        expect(totalOutput).toBeLessThan(90);
      });

      it('should preserve audio continuity', () => {
        const resampler = new Resampler(48000, 16000);

        // Create a sine wave split across chunks
        const fullWave = new Float32Array(480);
        for (let i = 0; i < 480; i++) {
          fullWave[i] = Math.sin((2 * Math.PI * i) / 48);
        }

        const chunk1 = fullWave.slice(0, 240);
        const chunk2 = fullWave.slice(240);

        const result1 = resampler.process(chunk1);
        const result2 = resampler.process(chunk2);

        // Results should be smooth (no discontinuity)
        const combined = new Float32Array(result1.length + result2.length);
        combined.set(result1, 0);
        combined.set(result2, result1.length);

        // Check for smoothness at the junction
        const junctionIndex = result1.length - 1;
        const diff = Math.abs(combined[junctionIndex + 1]! - combined[junctionIndex]!);
        expect(diff).toBeLessThan(0.5);
      });
    });

    describe('reset', () => {
      it('should clear carry-over state', () => {
        const resampler = new Resampler(48000, 16000);

        // Process some samples
        resampler.process(new Float32Array(100));

        // Reset
        resampler.reset();

        // Process again - should start fresh
        const samples = new Float32Array(48);
        const result = resampler.process(samples);
        expect(result.length).toBe(16);
      });
    });
  });

  describe('downsampleTo16kHz', () => {
    it('should downsample 48kHz to 16kHz', () => {
      const samples = new Float32Array(480);
      const result = downsampleTo16kHz(samples, 48000);
      expect(result.length).toBe(160);
    });

    it('should downsample 44.1kHz to 16kHz', () => {
      const samples = new Float32Array(441);
      const result = downsampleTo16kHz(samples, 44100);
      expect(result.length).toBe(160);
    });

    it('should return same array for 16kHz input', () => {
      const samples = new Float32Array(160);
      const result = downsampleTo16kHz(samples, 16000);
      expect(result).toBe(samples);
    });

    it('should handle 22.05kHz input', () => {
      const samples = new Float32Array(2205);
      const result = downsampleTo16kHz(samples, 22050);
      expect(result.length).toBe(1600);
    });
  });

  describe('upsampleFrom16kHz', () => {
    it('should upsample to 48kHz', () => {
      const samples = new Float32Array(160);
      const result = upsampleFrom16kHz(samples, 48000);
      expect(result.length).toBe(480);
    });

    it('should upsample to 44.1kHz', () => {
      const samples = new Float32Array(160);
      const result = upsampleFrom16kHz(samples, 44100);
      expect(result.length).toBe(441);
    });

    it('should return same array for 16kHz output', () => {
      const samples = new Float32Array(160);
      const result = upsampleFrom16kHz(samples, 16000);
      expect(result).toBe(samples);
    });

    it('should preserve signal shape', () => {
      // Create a sine wave at 16kHz
      const samples = new Float32Array(160);
      for (let i = 0; i < 160; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 16);
      }

      const upsampled = upsampleFrom16kHz(samples, 48000);

      // The upsampled signal should still look like a sine wave
      expect(upsampled[0]).toBeCloseTo(0, 1);
      // Peak should be around sample 12 (quarter period of 48 samples)
      expect(Math.abs(upsampled[12]!)).toBeGreaterThan(0.8);
    });
  });

  describe('Round-trip conversion', () => {
    it('should approximately preserve signal after downsample + upsample', () => {
      // Create original signal at 48kHz
      const original = new Float32Array(480);
      for (let i = 0; i < 480; i++) {
        // Low frequency sine to avoid aliasing
        original[i] = Math.sin((2 * Math.PI * i) / 480);
      }

      // Downsample to 16kHz
      const downsampled = downsampleTo16kHz(original, 48000);
      expect(downsampled.length).toBe(160);

      // Upsample back to 48kHz
      const restored = upsampleFrom16kHz(downsampled, 48000);
      expect(restored.length).toBe(480);

      // Check correlation (signals should be similar)
      let sumProduct = 0;
      let sumOrigSquare = 0;
      let sumRestoredSquare = 0;

      for (let i = 0; i < 480; i++) {
        sumProduct += original[i]! * restored[i]!;
        sumOrigSquare += original[i]! * original[i]!;
        sumRestoredSquare += restored[i]! * restored[i]!;
      }

      const correlation = sumProduct / Math.sqrt(sumOrigSquare * sumRestoredSquare);
      expect(correlation).toBeGreaterThan(0.9);
    });
  });

  describe('resampleToVADRate (TASK-271 L-2)', () => {
    it('returns input untouched when already at 16 kHz', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3]);
      const result = resampleToVADRate(samples, VAD_SAMPLE_RATE);
      expect(result).toBe(samples);
    });

    it('downsamples a 48 kHz buffer to 16 kHz with a 3:1 ratio (one second)', () => {
      const oneSecondAt48k = new Float32Array(48000);
      for (let i = 0; i < oneSecondAt48k.length; i++) {
        oneSecondAt48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
      }

      const result = resampleToVADRate(oneSecondAt48k, 48000);

      expect(result.length).toBeGreaterThan(15990);
      expect(result.length).toBeLessThan(16010);
    });

    it('downsamples a 44.1 kHz buffer to 16 kHz', () => {
      const samples = new Float32Array(44100);
      const result = resampleToVADRate(samples, 44100);

      // 44100 -> 16000: expected ~16000 samples per second of input
      expect(result.length).toBeGreaterThan(15990);
      expect(result.length).toBeLessThan(16010);
    });

    it('handles short buffers (one v5 frame worth of 48 kHz audio)', () => {
      const frameAt48k = new Float32Array(1536);
      const result = resampleToVADRate(frameAt48k, 48000);

      expect(result.length).toBeGreaterThanOrEqual(510);
      expect(result.length).toBeLessThanOrEqual(514);
    });
  });
});
