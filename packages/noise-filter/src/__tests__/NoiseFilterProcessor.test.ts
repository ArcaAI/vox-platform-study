/**
 * @arcaai/noise-filter - NoiseFilterProcessor Tests
 *
 * Tests for the main high-level noise filter processor.
 * These tests run in Node environment with mocked browser APIs.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoiseFilterProcessor, createNoiseFilter } from '../processors/NoiseFilterProcessor.js';
import { DEFAULT_NOISE_FILTER_OPTIONS } from '../types/index.js';

// Mock the browser support module
vi.mock('../utils/browserSupport.js', () => ({
  getNoiseFilterBrowserSupport: vi.fn(() => ({
    webAssembly: false,
    audioWorklet: false,
    sharedArrayBuffer: false,
    rnnoiseSupported: false,
    nativeFallbackAvailable: false,
    unsupportedReason: 'AudioContext not supported',
  })),
  isRNNoiseSupported: vi.fn(() => false),
}));

// Mock the worklet loader
vi.mock('../worklets/worklet-loader.js', () => ({
  registerRNNoiseWorklet: vi.fn(),
  createRNNoiseWorkletNode: vi.fn(),
  isWorkletRegistered: vi.fn(() => false),
}));

describe('NoiseFilterProcessor', () => {
  let processor: NoiseFilterProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new NoiseFilterProcessor();
  });

  afterEach(async () => {
    await processor.destroy();
  });

  describe('constructor', () => {
    it('should create instance with default options', () => {
      expect(processor).toBeInstanceOf(NoiseFilterProcessor);
    });

    it('should create instance with custom options', () => {
      const customProcessor = new NoiseFilterProcessor({
        noiseCancellation: true,
        noiseCancellationLevel: 'high',
        echoCancellation: false,
        autoGainControl: false,
        enableStats: true,
        statsInterval: 500,
      });

      const options = customProcessor.getOptions();
      expect(options.noiseCancellation).toBe(true);
      expect(options.noiseCancellationLevel).toBe('high');
      expect(options.echoCancellation).toBe(false);
      expect(options.autoGainControl).toBe(false);
      expect(options.enableStats).toBe(true);
      expect(options.statsInterval).toBe(500);
    });

    it('should merge custom options with defaults', () => {
      const customProcessor = new NoiseFilterProcessor({
        noiseCancellationLevel: 'low',
      });

      const options = customProcessor.getOptions();
      expect(options.noiseCancellationLevel).toBe('low');
      // Should still have defaults for other options
      expect(options.noiseCancellation).toBe(DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellation);
      expect(options.echoCancellation).toBe(DEFAULT_NOISE_FILTER_OPTIONS.echoCancellation);
    });
  });

  describe('createNoiseFilter factory function', () => {
    it('should create a NoiseFilterProcessor instance', () => {
      const filter = createNoiseFilter();
      expect(filter).toBeInstanceOf(NoiseFilterProcessor);
    });

    it('should pass options to the processor', () => {
      const filter = createNoiseFilter({
        noiseCancellationLevel: 'high',
        enableStats: true,
      });

      const options = filter.getOptions();
      expect(options.noiseCancellationLevel).toBe('high');
      expect(options.enableStats).toBe(true);
    });

    it('should handle undefined options', () => {
      const filter = createNoiseFilter(undefined);
      expect(filter).toBeInstanceOf(NoiseFilterProcessor);
    });
  });

  describe('isSupported', () => {
    it('should return false when browser support is unavailable', () => {
      expect(processor.isSupported()).toBe(false);
    });
  });

  describe('getNoiseLevel', () => {
    it('should return default level', () => {
      expect(processor.getNoiseLevel()).toBe('medium');
    });

    it('should return configured level', () => {
      const customProcessor = new NoiseFilterProcessor({
        noiseCancellationLevel: 'high',
      });
      expect(customProcessor.getNoiseLevel()).toBe('high');
    });
  });

  describe('setNoiseLevel', () => {
    it('should update the noise level', async () => {
      await processor.setNoiseLevel('high');
      expect(processor.getNoiseLevel()).toBe('high');
    });

    it('should accept all valid levels', async () => {
      await processor.setNoiseLevel('low');
      expect(processor.getNoiseLevel()).toBe('low');

      await processor.setNoiseLevel('medium');
      expect(processor.getNoiseLevel()).toBe('medium');

      await processor.setNoiseLevel('high');
      expect(processor.getNoiseLevel()).toBe('high');
    });
  });

  describe('getStats', () => {
    it('should return null when processor not initialized', () => {
      expect(processor.getStats()).toBeNull();
    });
  });

  describe('isUsingFallback', () => {
    it('should return false initially', () => {
      expect(processor.isUsingFallback()).toBe(false);
    });
  });

  describe('getOptions', () => {
    it('should return a copy of options', () => {
      const options1 = processor.getOptions();
      const options2 = processor.getOptions();

      expect(options1).toEqual(options2);
      expect(options1).not.toBe(options2); // Should be different object references
    });

    it('should include all default options', () => {
      const options = processor.getOptions();

      expect(options).toHaveProperty('noiseCancellation');
      expect(options).toHaveProperty('noiseCancellationLevel');
      expect(options).toHaveProperty('echoCancellation');
      expect(options).toHaveProperty('autoGainControl');
      expect(options).toHaveProperty('processingMode');
      expect(options).toHaveProperty('sampleRate');
      expect(options).toHaveProperty('enableStats');
      expect(options).toHaveProperty('statsInterval');
    });
  });

  describe('updateOptions', () => {
    it('should update noise cancellation level', async () => {
      await processor.updateOptions({ noiseCancellationLevel: 'low' });
      expect(processor.getNoiseLevel()).toBe('low');
    });

    it('should update enableStats option', async () => {
      await processor.updateOptions({ enableStats: true });
      const options = processor.getOptions();
      expect(options.enableStats).toBe(true);
    });

    it('should update statsInterval option', async () => {
      await processor.updateOptions({ statsInterval: 2000 });
      const options = processor.getOptions();
      expect(options.statsInterval).toBe(2000);
    });

    it('should handle partial updates', async () => {
      const originalOptions = processor.getOptions();
      await processor.updateOptions({ noiseCancellationLevel: 'high' });

      const newOptions = processor.getOptions();
      expect(newOptions.noiseCancellationLevel).toBe('high');
      expect(newOptions.echoCancellation).toBe(originalOptions.echoCancellation);
    });

    it('should handle empty options object', async () => {
      const originalOptions = processor.getOptions();
      await processor.updateOptions({});

      const newOptions = processor.getOptions();
      expect(newOptions).toEqual(originalOptions);
    });

    // Repeated enableStats updates must not leak setInterval handles.
    it('does not leak setInterval handles when enableStats is toggled on repeatedly', async () => {
      const setSpy = vi.spyOn(globalThis, 'setInterval');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');

      try {
        // First enable: 1 setInterval, 0 clearInterval
        await processor.updateOptions({ enableStats: true });
        const setCallsAfterFirst = setSpy.mock.calls.length;
        expect(setCallsAfterFirst).toBeGreaterThanOrEqual(1);

        // Re-enable while already enabled: should clear the previous timer
        // before starting a new one (was: leaks the previous one)
        await processor.updateOptions({ enableStats: true });

        const setCallsAfterSecond = setSpy.mock.calls.length;
        const clearCallsAfterSecond = clearSpy.mock.calls.length;

        // Every additional startStatsEmission() must be preceded by a clearInterval.
        expect(setCallsAfterSecond - setCallsAfterFirst).toBe(1);
        expect(clearCallsAfterSecond).toBeGreaterThanOrEqual(1);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
    });

    it('clears the prior timer when statsInterval is updated while enabled', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      try {
        await processor.updateOptions({ enableStats: true });
        const before = clearSpy.mock.calls.length;
        await processor.updateOptions({ statsInterval: 250 });
        expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
      } finally {
        clearSpy.mockRestore();
      }
    });
  });

  describe('destroy', () => {
    it('should be safe to call multiple times', async () => {
      await processor.destroy();
      await processor.destroy();
      await processor.destroy();
      // No error should be thrown
    });
  });
});

describe('NoiseFilterProcessor default options', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellation).toBe(true);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellationLevel).toBe('medium');
    expect(DEFAULT_NOISE_FILTER_OPTIONS.echoCancellation).toBe(true);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.autoGainControl).toBe(true);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.processingMode).toBe('quality');
    expect(DEFAULT_NOISE_FILTER_OPTIONS.sampleRate).toBe(48000);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.enableStats).toBe(false);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.statsInterval).toBe(1000);
  });

  it('should have sample rate matching RNNoise expected rate', () => {
    // RNNoise is optimized for 48kHz
    expect(DEFAULT_NOISE_FILTER_OPTIONS.sampleRate).toBe(48000);
  });
});

describe('NoiseFilterProcessor configuration scenarios', () => {
  it('should handle minimal configuration', () => {
    const processor = createNoiseFilter({});
    const options = processor.getOptions();

    // Should have all defaults
    expect(options.noiseCancellation).toBe(true);
    expect(options.noiseCancellationLevel).toBe('medium');
  });

  it('should handle custom WASM path', () => {
    const processor = createNoiseFilter({
      wasmPath: '/custom/path/to/rnnoise.wasm',
    });

    const options = processor.getOptions();
    expect(options.wasmPath).toBe('/custom/path/to/rnnoise.wasm');
  });

  it('should handle performance mode configuration', () => {
    const processor = createNoiseFilter({
      processingMode: 'performance',
    });

    const options = processor.getOptions();
    expect(options.processingMode).toBe('performance');
  });

  it('should handle quality mode configuration', () => {
    const processor = createNoiseFilter({
      processingMode: 'quality',
    });

    const options = processor.getOptions();
    expect(options.processingMode).toBe('quality');
  });

  it('should handle stats-enabled configuration', () => {
    const processor = createNoiseFilter({
      enableStats: true,
      statsInterval: 250,
    });

    const options = processor.getOptions();
    expect(options.enableStats).toBe(true);
    expect(options.statsInterval).toBe(250);
  });

  it('should handle all noise cancellation levels', () => {
    const levels = ['low', 'medium', 'high'] as const;

    for (const level of levels) {
      const processor = createNoiseFilter({
        noiseCancellationLevel: level,
      });
      expect(processor.getNoiseLevel()).toBe(level);
    }
  });
});
