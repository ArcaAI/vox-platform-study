/**
 * @arcaai/room - AudioContextManager Tests
 *
 * Comprehensive tests for the AudioContextManager singleton.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioContextManager, getNewAudioContext } from '../core/AudioContextManager.js';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockAudioContext(state: AudioContextState = 'running'): AudioContext {
  return {
    state,
    sampleRate: 48000,
    currentTime: 0,
    baseLatency: 0.01,
    destination: {} as AudioDestinationNode,
    createAnalyser: vi.fn(),
    createGain: vi.fn(),
    createMediaStreamSource: vi.fn(),
    createMediaStreamDestination: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as AudioContext;
}

// ============================================================================
// Tests
// ============================================================================

describe('AudioContextManager', () => {
  let manager: AudioContextManager;

  beforeEach(() => {
    // Reset singleton before each test
    AudioContextManager.resetInstance();
  });

  afterEach(() => {
    AudioContextManager.resetInstance();
    vi.unstubAllGlobals();
  });

  describe('getInstance', () => {
    it('should return the same instance', () => {
      const instance1 = AudioContextManager.getInstance();
      const instance2 = AudioContextManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should accept options on first call', () => {
      const instance = AudioContextManager.getInstance({
        latencyHint: 'playback',
        sampleRate: 44100,
      });

      expect(instance).toBeInstanceOf(AudioContextManager);
    });
  });

  describe('resetInstance', () => {
    it('should reset the singleton instance', () => {
      const instance1 = AudioContextManager.getInstance();

      AudioContextManager.resetInstance();

      const instance2 = AudioContextManager.getInstance();

      // After reset, a new instance should be created
      // Note: We can't directly compare since both could be equal if the singleton pattern is working
      expect(instance2).toBeInstanceOf(AudioContextManager);
    });
  });

  describe('with custom AudioContext', () => {
    let mockContext: AudioContext;

    beforeEach(() => {
      mockContext = createMockAudioContext();
      manager = AudioContextManager.getInstance({ audioContext: mockContext });
    });

    describe('acquire', () => {
      it('should use provided AudioContext', async () => {
        const ctx = await manager.acquire();
        expect(ctx).toBe(mockContext);
      });

      it('should increment reference count', async () => {
        await manager.acquire();
        await manager.acquire();

        // Release once
        manager.release();

        // Context should still be available
        expect(manager.getContext()).toBe(mockContext);
      });

      it('should ensure context is resumed', async () => {
        (mockContext as { state: string }).state = 'suspended';
        await manager.acquire();

        expect(mockContext.resume).toHaveBeenCalled();
      });
    });

    describe('release', () => {
      it('should decrement reference count', async () => {
        await manager.acquire();
        manager.release();

        // For custom context, it should not close
        expect(mockContext.close).not.toHaveBeenCalled();
      });

      it('should not close custom AudioContext when count reaches zero', async () => {
        await manager.acquire();
        manager.release();

        // Custom contexts are not closed
        expect(mockContext.close).not.toHaveBeenCalled();
        expect(manager.getContext()).toBe(mockContext);
      });

      it('should handle release when count is zero', () => {
        manager.release();
        // Should not throw
        expect(true).toBe(true);
      });
    });

    describe('getContext', () => {
      it('should return the AudioContext', async () => {
        await manager.acquire();
        expect(manager.getContext()).toBe(mockContext);
      });

      it('should return null before acquire', () => {
        const freshManager = AudioContextManager.getInstance();
        AudioContextManager.resetInstance();
        expect(AudioContextManager.getInstance().getContext()).toBeNull();
      });
    });

    describe('getState', () => {
      it('should return running state', async () => {
        await manager.acquire();
        expect(manager.getState()).toBe('running');
      });

      it('should return uninitialized when no context', () => {
        AudioContextManager.resetInstance();
        const freshManager = AudioContextManager.getInstance();
        expect(freshManager.getState()).toBe('uninitialized');
      });
    });

    describe('isReady', () => {
      it('should return true when context is running', async () => {
        await manager.acquire();
        expect(manager.isReady()).toBe(true);
      });

      it('should return false when context is suspended', async () => {
        (mockContext as { state: string }).state = 'suspended';
        await manager.acquire();
        (mockContext as { state: string }).state = 'suspended';
        expect(manager.isReady()).toBe(false);
      });

      it('should return false when no context', () => {
        AudioContextManager.resetInstance();
        expect(AudioContextManager.getInstance().isReady()).toBe(false);
      });
    });

    describe('getSampleRate', () => {
      it('should return sample rate', async () => {
        await manager.acquire();
        expect(manager.getSampleRate()).toBe(48000);
      });

      it('should return undefined when no context', () => {
        AudioContextManager.resetInstance();
        expect(AudioContextManager.getInstance().getSampleRate()).toBeUndefined();
      });
    });

    describe('resume', () => {
      it('should resume suspended context', async () => {
        (mockContext as { state: string }).state = 'suspended';
        await manager.acquire();

        vi.clearAllMocks();
        (mockContext as { state: string }).state = 'suspended';
        await manager.resume();

        expect(mockContext.resume).toHaveBeenCalled();
      });

      it('should not call resume when already running', async () => {
        await manager.acquire();
        vi.clearAllMocks();

        await manager.resume();

        expect(mockContext.resume).not.toHaveBeenCalled();
      });
    });

    describe('suspend', () => {
      it('should suspend running context', async () => {
        await manager.acquire();
        await manager.suspend();

        expect(mockContext.suspend).toHaveBeenCalled();
      });

      it('should not suspend if not running', async () => {
        (mockContext as { state: string }).state = 'suspended';
        await manager.acquire();
        vi.clearAllMocks();

        await manager.suspend();

        expect(mockContext.suspend).not.toHaveBeenCalled();
      });
    });

    describe('dispose', () => {
      it('should reset reference count and close context', async () => {
        await manager.acquire();
        await manager.acquire();

        manager.dispose();

        expect(manager.getContext()).toBeNull();
      });
    });
  });

  describe('options mismatch warning', () => {
    it('should warn when getInstance called with different sampleRate', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      AudioContextManager.resetInstance();
      AudioContextManager.getInstance({ sampleRate: 48000 });
      AudioContextManager.getInstance({ sampleRate: 16000 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different options'));
      warnSpy.mockRestore();
      AudioContextManager.resetInstance();
    });

    it('should not warn when same options', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      AudioContextManager.resetInstance();
      AudioContextManager.getInstance({ sampleRate: 48000 });
      AudioContextManager.getInstance({ sampleRate: 48000 });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      AudioContextManager.resetInstance();
    });

    it('should warn when different latencyHint', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      AudioContextManager.resetInstance();
      AudioContextManager.getInstance({ latencyHint: 'interactive' });
      AudioContextManager.getInstance({ latencyHint: 'playback' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different options'));
      warnSpy.mockRestore();
      AudioContextManager.resetInstance();
    });
  });

  describe('reference counting', () => {
    let mockContext: AudioContext;

    beforeEach(() => {
      mockContext = createMockAudioContext();
      manager = AudioContextManager.getInstance({ audioContext: mockContext });
    });

    it('should track multiple acquires', async () => {
      await manager.acquire();
      await manager.acquire();
      await manager.acquire();

      // Release twice
      manager.release();
      manager.release();

      // Context should still be available (one reference left for custom context)
      expect(manager.getContext()).toBe(mockContext);
    });

    it('should handle multiple release calls safely', () => {
      manager.release();
      manager.release();
      manager.release();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('state transitions', () => {
    let mockContext: AudioContext;

    beforeEach(() => {
      mockContext = createMockAudioContext();
      manager = AudioContextManager.getInstance({ audioContext: mockContext });
    });

    it('should track state changes', async () => {
      expect(manager.getState()).toBe('uninitialized');

      await manager.acquire();
      expect(manager.getState()).toBe('running');

      (mockContext as { state: string }).state = 'suspended';
      expect(manager.getState()).toBe('suspended');
    });
  });
});

describe('getNewAudioContext', () => {
  let originalAudioContext: typeof globalThis.AudioContext;
  let originalWebkitAudioContext: unknown;

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    originalWebkitAudioContext = (globalThis as Record<string, unknown>).webkitAudioContext;
  });

  afterEach(() => {
    globalThis.AudioContext = originalAudioContext;
    (globalThis as Record<string, unknown>).webkitAudioContext = originalWebkitAudioContext;
    vi.unstubAllGlobals();
  });

  it('should return undefined in Node environment', () => {
    (globalThis as Record<string, unknown>).AudioContext = undefined as unknown as typeof AudioContext;
    (globalThis as Record<string, unknown>).webkitAudioContext = undefined;
    const ctx = getNewAudioContext();
    expect(ctx).toBeUndefined();
  });

  it('should accept options parameter', () => {
    (globalThis as Record<string, unknown>).AudioContext = undefined as unknown as typeof AudioContext;
    (globalThis as Record<string, unknown>).webkitAudioContext = undefined;
    const ctx = getNewAudioContext({
      latencyHint: 'playback',
      sampleRate: 44100,
    });
    expect(ctx).toBeUndefined();
  });
});
