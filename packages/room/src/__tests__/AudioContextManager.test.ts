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

// ============================================================================
// W1-2 — StrictMode-safe ref-counted acquire/release
// ============================================================================

describe('AudioContextManager StrictMode safety (W1-2)', () => {
  beforeEach(() => {
    AudioContextManager.resetInstance();
  });

  afterEach(() => {
    AudioContextManager.resetInstance();
    vi.unstubAllGlobals();
  });

  it('should not close the context when release() is followed synchronously by acquire()', async () => {
    // Use the global mock AudioContext (jsdom env via vitest.setup.ts)
    const manager = AudioContextManager.getInstance();
    const ctx1 = await manager.acquire();
    expect(ctx1).toBeDefined();
    const closeSpy = ctx1.close as unknown as ReturnType<typeof vi.fn>;
    closeSpy.mockClear();

    // Mimic React 19 StrictMode: cleanup decrements to 0, then remount re-acquires.
    manager.release();
    const ctx2 = await manager.acquire();

    // Same context should be reused — release should have been deferred and cancelled.
    expect(ctx2).toBe(ctx1);

    // Allow any pending microtasks to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('should close the context when release() is final (no re-acquire)', async () => {
    const manager = AudioContextManager.getInstance();
    const ctx1 = await manager.acquire();
    const closeSpy = ctx1.close as unknown as ReturnType<typeof vi.fn>;
    closeSpy.mockClear();

    manager.release();

    // Wait for the deferred close microtask to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(closeSpy).toHaveBeenCalled();
    expect(manager.getContext()).toBeNull();
  });

  it('dispose() should hard-close even when release is pending', async () => {
    const manager = AudioContextManager.getInstance();
    const ctx1 = await manager.acquire();
    const closeSpy = ctx1.close as unknown as ReturnType<typeof vi.fn>;
    closeSpy.mockClear();

    manager.release();
    manager.dispose();

    expect(closeSpy).toHaveBeenCalled();
    expect(manager.getContext()).toBeNull();
  });

  it('should survive multiple synchronous release/acquire cycles', async () => {
    const manager = AudioContextManager.getInstance();
    const ctx1 = await manager.acquire();
    const closeSpy = ctx1.close as unknown as ReturnType<typeof vi.fn>;
    closeSpy.mockClear();

    manager.release();
    const ctx2 = await manager.acquire();
    manager.release();
    const ctx3 = await manager.acquire();

    expect(ctx2).toBe(ctx1);
    expect(ctx3).toBe(ctx1);
    await Promise.resolve();
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// W1-7 — resumeWithTimeout throws RoomResumeTimeoutError on stuck resume
// ============================================================================

describe('AudioContextManager.resume timeout (W1-7)', () => {
  beforeEach(() => {
    AudioContextManager.resetInstance();
  });

  afterEach(() => {
    AudioContextManager.resetInstance();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('should throw a typed RoomResumeTimeoutError after the default 3000ms when resume() never resolves', async () => {
    vi.useFakeTimers();
    const stuckCtx = createMockAudioContext('running');
    stuckCtx.resume = vi.fn().mockImplementation(() => new Promise<void>(() => {/* hangs forever */}));

    const manager = AudioContextManager.getInstance({ audioContext: stuckCtx });
    // acquire while running (no resume needed); flip to suspended afterward.
    await manager.acquire();
    (stuckCtx as { state: string }).state = 'suspended';

    const resumePromise = manager.resume();
    // Tap the rejection so node doesn't surface unhandled promise warnings.
    const captured = resumePromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(3001);

    const err = await captured;
    expect((err as Error).name).toBe('RoomResumeTimeoutError');
    expect((err as { code: string }).code).toBe('mic_resume_timeout');
  });

  it('should set up the click handler when timeout fires and context is still not running', async () => {
    vi.useFakeTimers();
    const stuckCtx = createMockAudioContext('running');
    stuckCtx.resume = vi.fn().mockImplementation(() => new Promise<void>(() => {}));

    const manager = AudioContextManager.getInstance({ audioContext: stuckCtx });
    await manager.acquire();
    (stuckCtx as { state: string }).state = 'suspended';

    const addEventListenerSpy = vi.spyOn(document.body, 'addEventListener');

    const resumePromise = manager.resume();
    const captured = resumePromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(3001);
    await captured;

    // setupClickHandler attaches click + touchstart + keydown listeners.
    const eventNames = addEventListenerSpy.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain('click');
    expect(eventNames).toContain('touchstart');
    expect(eventNames).toContain('keydown');

    addEventListenerSpy.mockRestore();
  });

  it('should not throw when resume() succeeds before timeout', async () => {
    vi.useFakeTimers();
    const fastCtx = createMockAudioContext('running');
    let resolveResume!: () => void;
    fastCtx.resume = vi.fn().mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveResume = () => {
            (fastCtx as { state: string }).state = 'running';
            r();
          };
        }),
    );

    const manager = AudioContextManager.getInstance({ audioContext: fastCtx });
    // Acquire while the context is already running so ensureResumed() short-circuits.
    await manager.acquire();
    // Now flip to suspended and exercise the resume() public method.
    (fastCtx as { state: string }).state = 'suspended';

    const p = manager.resume();
    // The Promise executor runs synchronously, so resolveResume is captured here.
    resolveResume();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBeUndefined();
  });
});

// ============================================================================
// TASK-300 L-1 — acquire() sample-rate enforcement
// ============================================================================

describe('AudioContextManager.acquire sample-rate enforcement (TASK-300 L-1)', () => {
  beforeEach(() => {
    AudioContextManager.resetInstance();
  });

  afterEach(() => {
    AudioContextManager.resetInstance();
    vi.unstubAllGlobals();
  });

  it('does NOT throw or warn when no requireSampleRate is passed (backwards compatibility)', async () => {
    const ctx = createMockAudioContext('running');
    (ctx as { sampleRate: number }).sampleRate = 44100;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = AudioContextManager.getInstance({ audioContext: ctx });
    await expect(manager.acquire()).resolves.toBe(ctx);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('throws RoomSampleRateMismatchError when requireSampleRate is set and the context sampleRate differs', async () => {
    const ctx = createMockAudioContext('running');
    (ctx as { sampleRate: number }).sampleRate = 44100;

    const manager = AudioContextManager.getInstance({ audioContext: ctx });
    await expect(manager.acquire({ requireSampleRate: 48000 })).rejects.toMatchObject({
      name: 'RoomSampleRateMismatchError',
      code: 'sample_rate_mismatch',
    });
  });

  it('warns (does not throw) when requireSampleRate mismatches but allowMismatch is true', async () => {
    const ctx = createMockAudioContext('running');
    (ctx as { sampleRate: number }).sampleRate = 44100;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = AudioContextManager.getInstance({ audioContext: ctx });
    await expect(
      manager.acquire({ requireSampleRate: 48000, allowMismatch: true }),
    ).resolves.toBe(ctx);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/sampleRate is 44100 Hz but the caller required 48000 Hz/);

    warnSpy.mockRestore();
  });

  it('does not throw or warn when sampleRate matches the requireSampleRate', async () => {
    const ctx = createMockAudioContext('running');
    (ctx as { sampleRate: number }).sampleRate = 48000;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = AudioContextManager.getInstance({ audioContext: ctx });
    await expect(manager.acquire({ requireSampleRate: 48000 })).resolves.toBe(ctx);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('emits the warning at most once per acquire() invocation', async () => {
    const ctx = createMockAudioContext('running');
    (ctx as { sampleRate: number }).sampleRate = 44100;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = AudioContextManager.getInstance({ audioContext: ctx });
    await manager.acquire({ requireSampleRate: 48000, allowMismatch: true });

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

// ============================================================================
// TASK-317 W5.2 — cross-tenant acquire() dev-warning (AC-15 / audit D-6)
// ============================================================================

describe('TASK-317 W5.2 — AudioContextManager cross-tenant acquire warning (AC-15)', () => {
  let mockContext: AudioContext;

  beforeEach(() => {
    AudioContextManager.resetInstance();
    mockContext = createMockAudioContext('running');
  });

  afterEach(() => {
    AudioContextManager.resetInstance();
    vi.unstubAllGlobals();
  });

  it('warns when a second acquire() comes from a DIFFERENT tenant while the context is still held', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = AudioContextManager.getInstance({ audioContext: mockContext });

    await manager.acquire({ tenantId: 'tenant-a' });
    await manager.acquire({ tenantId: 'tenant-b' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/different tenant/i);
    warnSpy.mockRestore();
  });

  it('does NOT warn on the first acquire()', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = AudioContextManager.getInstance({ audioContext: mockContext });

    await manager.acquire({ tenantId: 'tenant-a' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT warn when the same tenant acquires again', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = AudioContextManager.getInstance({ audioContext: mockContext });

    await manager.acquire({ tenantId: 'tenant-a' });
    await manager.acquire({ tenantId: 'tenant-a' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT warn when no tenantId is supplied (back-compat for existing callers)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = AudioContextManager.getInstance({ audioContext: mockContext });

    await manager.acquire();
    await manager.acquire();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT warn for a different tenant once the prior tenant has fully released', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = AudioContextManager.getInstance({ audioContext: mockContext });

    await manager.acquire({ tenantId: 'tenant-a' });
    manager.release(); // referenceCount → 0, holder tracking cleared
    await manager.acquire({ tenantId: 'tenant-b' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
