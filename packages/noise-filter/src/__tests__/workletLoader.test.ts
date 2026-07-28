/**
 * @arcaai/noise-filter - Worklet Loader Tests
 *
 * Tests for the worklet registration and node creation utilities.
 * These tests run in Node environment with mocked browser APIs.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WORKLET_PROCESSOR_NAME, cleanupWorkletResources } from '../worklets/worklet-loader.js';
import { NoiseFilterError, NoiseFilterErrorCode } from '../types/index.js';

describe('worklet-loader constants', () => {
  describe('WORKLET_PROCESSOR_NAME', () => {
    it('should have correct processor name', () => {
      expect(WORKLET_PROCESSOR_NAME).toBe('rnnoise-worklet-processor');
    });

    it('should be a non-empty string', () => {
      expect(typeof WORKLET_PROCESSOR_NAME).toBe('string');
      expect(WORKLET_PROCESSOR_NAME.length).toBeGreaterThan(0);
    });
  });
});

describe('cleanupWorkletResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be callable', () => {
    expect(() => cleanupWorkletResources()).not.toThrow();
  });

  it('should be safe to call multiple times', () => {
    cleanupWorkletResources();
    cleanupWorkletResources();
    cleanupWorkletResources();
    // No error should be thrown
  });
});

describe('worklet-loader with mocked AudioContext', () => {
  let mockAudioContext: {
    audioWorklet: {
      addModule: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockAudioContext = {
      audioWorklet: {
        addModule: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupWorkletResources();
  });

  describe('registerRNNoiseWorklet behavior', () => {
    it('should require AudioContext with audioWorklet', async () => {
      // Import dynamically to test with fresh module state
      const { registerRNNoiseWorklet } = await import('../worklets/worklet-loader.js');

      const contextWithoutWorklet = {} as AudioContext;

      await expect(registerRNNoiseWorklet(contextWithoutWorklet)).rejects.toThrow(NoiseFilterError);
    });
  });

  describe('isWorkletRegistered behavior', () => {
    it('should return false for unregistered context', async () => {
      const { isWorkletRegistered } = await import('../worklets/worklet-loader.js');

      const newContext = {
        audioWorklet: {
          addModule: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as AudioContext;

      expect(isWorkletRegistered(newContext)).toBe(false);
    });
  });

  describe('createRNNoiseWorkletNode behavior', () => {
    it('should throw error when worklet not registered', async () => {
      const { createRNNoiseWorkletNode } = await import('../worklets/worklet-loader.js');

      const unregisteredContext = {
        audioWorklet: {
          addModule: vi.fn(),
        },
      } as unknown as AudioContext;

      expect(() => createRNNoiseWorkletNode(unregisteredContext)).toThrow(NoiseFilterError);
    });

    it('should throw with correct error code', async () => {
      const { createRNNoiseWorkletNode } = await import('../worklets/worklet-loader.js');

      const unregisteredContext = {
        audioWorklet: {
          addModule: vi.fn(),
        },
      } as unknown as AudioContext;

      try {
        createRNNoiseWorkletNode(unregisteredContext);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NoiseFilterError);
        expect((error as NoiseFilterError).code).toBe(NoiseFilterErrorCode.WORKLET_REGISTRATION_FAILED);
      }
    });

    it('should throw with helpful message', async () => {
      const { createRNNoiseWorkletNode } = await import('../worklets/worklet-loader.js');

      const unregisteredContext = {} as AudioContext;

      try {
        createRNNoiseWorkletNode(unregisteredContext);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NoiseFilterError);
        expect((error as NoiseFilterError).message).toContain('registerRNNoiseWorklet');
      }
    });
  });
});

describe('generateWorkletSource (inline source)', () => {
  // Test that the inline worklet source contains expected code
  // This is important for bundling scenarios

  it('should export cleanupWorkletResources function', async () => {
    const module = await import('../worklets/worklet-loader.js');
    expect(typeof module.cleanupWorkletResources).toBe('function');
  });

  it('should export registerRNNoiseWorklet function', async () => {
    const module = await import('../worklets/worklet-loader.js');
    expect(typeof module.registerRNNoiseWorklet).toBe('function');
  });

  it('should export isWorkletRegistered function', async () => {
    const module = await import('../worklets/worklet-loader.js');
    expect(typeof module.isWorkletRegistered).toBe('function');
  });

  it('should export createRNNoiseWorkletNode function', async () => {
    const module = await import('../worklets/worklet-loader.js');
    expect(typeof module.createRNNoiseWorkletNode).toBe('function');
  });
});

describe('worklet registration flow', () => {
  it('should handle registration failure gracefully', async () => {
    const { registerRNNoiseWorklet } = await import('../worklets/worklet-loader.js');

    const failingContext = {
      audioWorklet: {
        addModule: vi.fn().mockRejectedValue(new Error('Network error')),
      },
    } as unknown as AudioContext;

    await expect(registerRNNoiseWorklet(failingContext)).rejects.toThrow(NoiseFilterError);
  });

  it('should include original error in thrown error', async () => {
    const { registerRNNoiseWorklet } = await import('../worklets/worklet-loader.js');

    const originalError = new Error('Module load failed');
    const failingContext = {
      audioWorklet: {
        addModule: vi.fn().mockRejectedValue(originalError),
      },
    } as unknown as AudioContext;

    try {
      await registerRNNoiseWorklet(failingContext);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NoiseFilterError);
      expect((error as NoiseFilterError).cause).toBe(originalError);
    }
  });
});

describe('edge cases', () => {
  it('should handle null audioWorklet', async () => {
    const { registerRNNoiseWorklet } = await import('../worklets/worklet-loader.js');

    const contextWithNullWorklet = {
      audioWorklet: null,
    } as unknown as AudioContext;

    await expect(registerRNNoiseWorklet(contextWithNullWorklet)).rejects.toThrow(NoiseFilterError);
  });

  it('should handle undefined audioWorklet', async () => {
    const { registerRNNoiseWorklet } = await import('../worklets/worklet-loader.js');

    const contextWithUndefinedWorklet = {} as AudioContext;

    await expect(registerRNNoiseWorklet(contextWithUndefinedWorklet)).rejects.toThrow(NoiseFilterError);
  });
});
