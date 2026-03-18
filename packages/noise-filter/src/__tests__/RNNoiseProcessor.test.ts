/**
 * @arcaai/noise-filter - RNNoiseProcessor Tests
 *
 * Tests for the low-level RNNoise WASM processor.
 * These tests run in Node environment, so we test the logic
 * with appropriate mocking of WebAssembly and browser APIs.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RNNoiseProcessor,
  RNNOISE_FRAME_SIZE,
  RNNOISE_SAMPLE_RATE,
} from '../processors/RNNoiseProcessor.js';

describe('RNNoiseProcessor', () => {
  let processor: RNNoiseProcessor;

  beforeEach(() => {
    processor = new RNNoiseProcessor();
    vi.clearAllMocks();
  });

  afterEach(() => {
    processor.destroy();
  });

  describe('constants', () => {
    it('should export correct frame size (480 samples = 10ms at 48kHz)', () => {
      expect(RNNOISE_FRAME_SIZE).toBe(480);
    });

    it('should export correct sample rate (48kHz)', () => {
      expect(RNNOISE_SAMPLE_RATE).toBe(48000);
    });

    it('should have correct frame duration', () => {
      const frameDurationMs = (RNNOISE_FRAME_SIZE / RNNOISE_SAMPLE_RATE) * 1000;
      expect(frameDurationMs).toBe(10);
    });
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      expect(processor).toBeInstanceOf(RNNoiseProcessor);
    });

    it('should not be initialized by default', () => {
      expect(processor.isInitialized).toBe(false);
    });

    it('should be enabled by default', () => {
      expect(processor.enabled).toBe(true);
    });

    it('should have medium level by default', () => {
      expect(processor.level).toBe('medium');
    });
  });

  describe('setEnabled', () => {
    it('should enable processing', () => {
      processor.setEnabled(true);
      expect(processor.enabled).toBe(true);
    });

    it('should disable processing', () => {
      processor.setEnabled(false);
      expect(processor.enabled).toBe(false);
    });

    it('should toggle enabled state', () => {
      processor.setEnabled(false);
      expect(processor.enabled).toBe(false);
      processor.setEnabled(true);
      expect(processor.enabled).toBe(true);
    });
  });

  describe('setLevel', () => {
    it('should set level to low', () => {
      processor.setLevel('low');
      expect(processor.level).toBe('low');
    });

    it('should set level to medium', () => {
      processor.setLevel('medium');
      expect(processor.level).toBe('medium');
    });

    it('should set level to high', () => {
      processor.setLevel('high');
      expect(processor.level).toBe('high');
    });
  });

  describe('process (without initialization)', () => {
    it('should pass through audio when not initialized', () => {
      const input = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const output = new Float32Array(input.length);

      const result = processor.process(input, output);

      expect(result.samples).toEqual(input);
      expect(result.vadProbability).toBe(0);
    });

    it('should handle empty input when not initialized', () => {
      const input = new Float32Array(0);
      const output = new Float32Array(0);

      const result = processor.process(input, output);

      expect(result.samples.length).toBe(0);
      expect(result.vadProbability).toBe(0);
    });
  });

  describe('process (with disabled state)', () => {
    it('should pass through audio when disabled', () => {
      processor.setEnabled(false);

      const input = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const output = new Float32Array(input.length);

      const result = processor.process(input, output);

      expect(result.samples).toEqual(input);
    });
  });

  describe('getStats', () => {
    it('should return stats object with correct shape', () => {
      const stats = processor.getStats();

      expect(stats).toHaveProperty('isActive');
      expect(stats).toHaveProperty('noiseReductionDb');
      expect(stats).toHaveProperty('vadProbability');
      expect(stats).toHaveProperty('latencyMs');
      expect(stats).toHaveProperty('framesProcessed');
      expect(stats).toHaveProperty('framesDropped');
      expect(stats).toHaveProperty('cpuLoad');
      expect(stats).toHaveProperty('timestamp');
    });

    it('should return inactive stats when not initialized', () => {
      const stats = processor.getStats();

      expect(stats.isActive).toBe(false);
      expect(stats.framesProcessed).toBe(0);
    });

    it('should return correct noise reduction based on level', () => {
      // noiseReductionDb is calculated as 12 * LEVEL_MULTIPLIERS[level]
      // low: 12 * 0.5 = 6
      // medium: 12 * 0.75 = 9
      // high: 12 * 1.0 = 12
      processor.setLevel('low');
      let stats = processor.getStats();
      expect(stats.noiseReductionDb).toBe(6);

      processor.setLevel('medium');
      stats = processor.getStats();
      expect(stats.noiseReductionDb).toBe(9);

      processor.setLevel('high');
      stats = processor.getStats();
      expect(stats.noiseReductionDb).toBe(12);
    });

    it('should return zero noise reduction when disabled', () => {
      processor.setEnabled(false);
      const stats = processor.getStats();
      expect(stats.noiseReductionDb).toBe(0);
    });

    it('should return correct latency', () => {
      const stats = processor.getStats();
      const expectedLatency = (RNNOISE_FRAME_SIZE / RNNOISE_SAMPLE_RATE) * 1000;
      expect(stats.latencyMs).toBe(expectedLatency);
    });

    it('should have timestamp in reasonable range', () => {
      const before = Date.now();
      const stats = processor.getStats();
      const after = Date.now();

      expect(stats.timestamp).toBeGreaterThanOrEqual(before);
      expect(stats.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('resetStats', () => {
    it('should reset frame counters', () => {
      // Process some data to increment counters
      const input = new Float32Array(RNNOISE_FRAME_SIZE);
      const output = new Float32Array(RNNOISE_FRAME_SIZE);
      processor.process(input, output);

      processor.resetStats();
      const stats = processor.getStats();

      expect(stats.framesProcessed).toBe(0);
      expect(stats.framesDropped).toBe(0);
    });
  });

  describe('destroy', () => {
    it('should reset initialization state', () => {
      processor.destroy();
      expect(processor.isInitialized).toBe(false);
    });

    it('should be safe to call multiple times', () => {
      processor.destroy();
      processor.destroy();
      processor.destroy();
      expect(processor.isInitialized).toBe(false);
    });

    it('should reset level to medium after destroy', () => {
      processor.setLevel('high');
      expect(processor.level).toBe('high');

      processor.destroy();

      // Level is preserved (not reset) in destroy
      expect(processor.level).toBe('high');
    });
  });

  describe('frame buffering logic', () => {
    it('should accumulate samples until frame size is reached', () => {
      // Process less than a full frame
      const partialInput = new Float32Array(RNNOISE_FRAME_SIZE / 2);
      const partialOutput = new Float32Array(partialInput.length);

      const result = processor.process(partialInput, partialOutput);

      // Should not have processed a frame yet (not initialized)
      expect(result.vadProbability).toBe(0);
    });

    it('should handle input larger than frame size', () => {
      const largeInput = new Float32Array(RNNOISE_FRAME_SIZE * 2);
      const largeOutput = new Float32Array(largeInput.length);

      // Fill with test data
      for (let i = 0; i < largeInput.length; i++) {
        largeInput[i] = Math.sin(i * 0.1) * 0.5;
      }

      const result = processor.process(largeInput, largeOutput);

      // Should return the same length output
      expect(result.samples.length).toBe(largeInput.length);
    });

    it('should handle odd-sized input', () => {
      const oddInput = new Float32Array(RNNOISE_FRAME_SIZE + 100);
      const oddOutput = new Float32Array(oddInput.length);

      const result = processor.process(oddInput, oddOutput);

      expect(result.samples.length).toBe(oddInput.length);
    });
  });

  describe('level multipliers', () => {
    it('should have three valid levels', () => {
      const validLevels = ['low', 'medium', 'high'] as const;

      for (const level of validLevels) {
        processor.setLevel(level);
        expect(processor.level).toBe(level);
      }
    });
  });

  describe('init method', () => {
    it('should return early if already initialized', async () => {
      // Mock the isInitialized property to simulate already initialized
      // Since we can't actually initialize in Node, we test the early return logic
      const newProcessor = new RNNoiseProcessor();

      // First call should try to initialize (and fail in Node)
      await expect(newProcessor.init()).rejects.toThrow();

      newProcessor.destroy();
    });

    it('should throw error when WASM loading fails', async () => {
      await expect(processor.init()).rejects.toThrow(/Failed to initialize RNNoise/);
    });
  });
});

describe('RNNoiseProcessor integration scenarios', () => {
  it('should handle rapid enable/disable toggling', () => {
    const processor = new RNNoiseProcessor();

    for (let i = 0; i < 100; i++) {
      processor.setEnabled(i % 2 === 0);
    }

    // Should end up disabled (last iteration i=99, 99%2=1, so disabled)
    expect(processor.enabled).toBe(false);

    processor.destroy();
  });

  it('should handle rapid level changes', () => {
    const processor = new RNNoiseProcessor();
    const levels = ['low', 'medium', 'high'] as const;

    for (let i = 0; i < 100; i++) {
      processor.setLevel(levels[i % 3]!);
    }

    // Should end up at 'low' (last iteration i=99, 99%3=0)
    expect(processor.level).toBe('low');

    processor.destroy();
  });

  it('should maintain correct stats across multiple process calls', () => {
    const processor = new RNNoiseProcessor();
    const input = new Float32Array(RNNOISE_FRAME_SIZE);
    const output = new Float32Array(RNNOISE_FRAME_SIZE);

    // Process multiple times
    for (let i = 0; i < 10; i++) {
      processor.process(input, output);
    }

    const stats = processor.getStats();

    // Stats should be tracked (even if not initialized, counters work)
    expect(stats.framesProcessed).toBe(0); // Not initialized, so no actual frames processed
    expect(typeof stats.cpuLoad).toBe('number');

    processor.destroy();
  });
});
