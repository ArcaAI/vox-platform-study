/**
 * @arcaai/vad - Worklet Loader Tests
 *
 * Tests for AudioWorklet loading and registration utilities.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VADError, VADErrorCode } from '../types/index.js';
import {
  WORKLET_PROCESSOR_NAME,
  registerVADWorklet,
  isVADWorkletRegistered,
  createVADWorkletNode,
  cleanupVADWorkletResources,
} from '../worklets/worklet-loader.js';

describe('worklet-loader utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up any cached state between tests
    cleanupVADWorkletResources();
  });

  describe('WORKLET_PROCESSOR_NAME', () => {
    it('should be vad-worklet-processor', () => {
      expect(WORKLET_PROCESSOR_NAME).toBe('vad-worklet-processor');
    });
  });

  describe('registerVADWorklet', () => {
    it('should register worklet with AudioContext that has audioWorklet', async () => {
      const addModuleMock = vi.fn().mockResolvedValue(undefined);
      const mockContext = {
        audioWorklet: {
          addModule: addModuleMock,
        },
        sampleRate: 48000,
        state: 'running',
      } as unknown as AudioContext;

      await registerVADWorklet(mockContext);

      expect(addModuleMock).toHaveBeenCalledTimes(1);
    });

    it('should not re-register for same AudioContext', async () => {
      const addModuleMock = vi.fn().mockResolvedValue(undefined);
      const mockContext = {
        audioWorklet: {
          addModule: addModuleMock,
        },
        sampleRate: 48000,
        state: 'running',
      } as unknown as AudioContext;

      await registerVADWorklet(mockContext);
      await registerVADWorklet(mockContext);

      expect(addModuleMock).toHaveBeenCalledTimes(1);
    });

    it('should use provided URL when specified', async () => {
      const addModuleMock = vi.fn().mockResolvedValue(undefined);
      const mockContext = {
        audioWorklet: {
          addModule: addModuleMock,
        },
        sampleRate: 48000,
        state: 'running',
      } as unknown as AudioContext;
      const customUrl = 'https://example.com/vad.worklet.js';

      await registerVADWorklet(mockContext, customUrl);

      expect(addModuleMock).toHaveBeenCalledWith(customUrl);
    });

    it('should throw VADError when AudioWorklet not supported', async () => {
      const mockContext = {
        audioWorklet: undefined,
        sampleRate: 48000,
        state: 'running',
      } as unknown as AudioContext;

      await expect(registerVADWorklet(mockContext)).rejects.toThrow();

      try {
        await registerVADWorklet(mockContext);
      } catch (e) {
        expect(e).toBeInstanceOf(VADError);
        expect((e as VADError).code).toBe(VADErrorCode.NOT_SUPPORTED);
      }
    });

    it('should throw VADError when addModule fails', async () => {
      const addModuleMock = vi.fn().mockRejectedValue(new Error('Failed to load module'));
      const mockContext = {
        audioWorklet: {
          addModule: addModuleMock,
        },
        sampleRate: 48000,
        state: 'running',
      } as unknown as AudioContext;

      await expect(registerVADWorklet(mockContext)).rejects.toThrow();

      try {
        // Create a fresh context to avoid caching
        const freshContext = {
          audioWorklet: {
            addModule: vi.fn().mockRejectedValue(new Error('Failed')),
          },
        } as unknown as AudioContext;
        await registerVADWorklet(freshContext);
      } catch (e) {
        expect(e).toBeInstanceOf(VADError);
        expect((e as VADError).code).toBe(VADErrorCode.WORKLET_REGISTRATION_FAILED);
      }
    });
  });

  describe('isVADWorkletRegistered', () => {
    it('should return false for unregistered AudioContext', () => {
      const mockContext = {
        audioWorklet: {
          addModule: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as AudioContext;

      expect(isVADWorkletRegistered(mockContext)).toBe(false);
    });

    it('should return true for registered AudioContext', async () => {
      const mockContext = {
        audioWorklet: {
          addModule: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as AudioContext;

      await registerVADWorklet(mockContext);

      expect(isVADWorkletRegistered(mockContext)).toBe(true);
    });

    it('should track multiple AudioContexts independently', async () => {
      const ctx1 = {
        audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      } as unknown as AudioContext;
      const ctx2 = {
        audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      } as unknown as AudioContext;

      await registerVADWorklet(ctx1);

      expect(isVADWorkletRegistered(ctx1)).toBe(true);
      expect(isVADWorkletRegistered(ctx2)).toBe(false);
    });
  });

  describe('createVADWorkletNode', () => {
    it('should throw VADError for unregistered context', () => {
      const mockContext = {
        audioWorklet: { addModule: vi.fn() },
      } as unknown as AudioContext;

      expect(() => createVADWorkletNode(mockContext)).toThrow();

      try {
        createVADWorkletNode(mockContext);
      } catch (e) {
        expect(e).toBeInstanceOf(VADError);
        expect((e as VADError).code).toBe(VADErrorCode.WORKLET_REGISTRATION_FAILED);
      }
    });

    it('should create AudioWorkletNode for registered context', async () => {
      // Mock AudioWorkletNode constructor
      const mockAudioWorkletNode = vi.fn();
      globalThis.AudioWorkletNode = mockAudioWorkletNode as unknown as typeof AudioWorkletNode;

      const mockContext = {
        audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      } as unknown as AudioContext;

      await registerVADWorklet(mockContext);

      createVADWorkletNode(mockContext);

      expect(mockAudioWorkletNode).toHaveBeenCalledWith(
        mockContext,
        WORKLET_PROCESSOR_NAME,
        expect.objectContaining({
          numberOfInputs: 1,
          numberOfOutputs: 1,
        })
      );
    });
  });

  describe('cleanupVADWorkletResources', () => {
    it('should be safe to call multiple times', () => {
      cleanupVADWorkletResources();
      cleanupVADWorkletResources();
      cleanupVADWorkletResources();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should be safe to call without prior registration', () => {
      // No registration, just cleanup
      cleanupVADWorkletResources();

      // Should not throw
      expect(true).toBe(true);
    });
  });
});

describe('worklet-loader error handling', () => {
  it('should include error message in VADError', async () => {
    const errorMessage = 'Network timeout';
    const mockContext = {
      audioWorklet: {
        addModule: vi.fn().mockRejectedValue(new Error(errorMessage)),
      },
    } as unknown as AudioContext;

    try {
      await registerVADWorklet(mockContext);
    } catch (e) {
      expect(e).toBeInstanceOf(VADError);
      expect((e as VADError).message).toContain(errorMessage);
    }
  });

  it('should handle non-Error rejection', async () => {
    const mockContext = {
      audioWorklet: {
        addModule: vi.fn().mockRejectedValue('String rejection'),
      },
    } as unknown as AudioContext;

    await expect(registerVADWorklet(mockContext)).rejects.toThrow(VADError);
  });
});
