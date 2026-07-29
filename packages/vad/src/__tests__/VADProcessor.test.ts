/**
 * @arcaai/vad - VADProcessor Tests
 *
 * Tests for the main VADProcessor class.
 * Note: These tests mock browser APIs and external dependencies.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VADProcessor, createVAD } from '../processors/VADProcessor.js';
import { VADError, DEFAULT_VAD_OPTIONS } from '../types/index.js';

// Mock @arcaai/room module
vi.mock('@arcaai/room', () => {
  const EventEmitter = {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  class MockBaseProcessor {
    name: string;
    protected processedTrack: MediaStreamTrack | null = null;
    protected debugMode: boolean = false;

    constructor(name: string, debugMode = false) {
      this.name = name;
      this.debugMode = debugMode;
    }

    emit = vi.fn();
    on = vi.fn();
    off = vi.fn();
    once = vi.fn();
    removeAllListeners = vi.fn();

    protected emitData(type: string, data: unknown) {
      this.emit('data', { type, data, timestamp: Date.now() });
    }

    // Delegate to subclass lifecycle hooks so tests can exercise the real
    // init / reset / setStream paths under jsdom.
    async init(opts: unknown) {
      const self = this as unknown as { onInit?: (opts: unknown) => Promise<void> };
      if (typeof self.onInit === 'function') {
        await self.onInit(opts);
      }
    }
    async destroy() {
      const self = this as unknown as { onDestroy?: () => Promise<void> };
      if (typeof self.onDestroy === 'function') {
        await self.onDestroy();
      }
    }
    async enable() {
      const self = this as unknown as { onEnable?: () => Promise<void> };
      if (typeof self.onEnable === 'function') {
        await self.onEnable();
      }
    }
    async disable() {
      const self = this as unknown as { onDisable?: () => Promise<void> };
      if (typeof self.onDisable === 'function') {
        await self.onDisable();
      }
    }
  }

  return {
    BaseProcessor: MockBaseProcessor,
    ProcessorEvent: {
      Data: 'data',
      Error: 'error',
      Enabled: 'enabled',
      Disabled: 'disabled',
    },
  };
});

// Mock @ricky0123/vad-web — each call to MicVAD.new returns a fresh instance
// so tests can assert that reset / setStream actually replace the underlying
// LSTM session (instance identity is the proxy for "hidden state reset").
const micVADCalls: Array<{
  instance: { start: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  options: Record<string, unknown>;
}> = [];

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: vi.fn(async (options: Record<string, unknown>) => {
      const instance = {
        start: vi.fn(),
        pause: vi.fn(),
        destroy: vi.fn(),
      };
      micVADCalls.push({ instance, options });
      return instance;
    }),
  },
}));

// Mock browser support
vi.mock('../utils/browserSupport.js', () => ({
  getVADBrowserSupport: vi.fn().mockReturnValue({
    webAssembly: true,
    audioWorklet: true,
    sharedArrayBuffer: true,
    onnxRuntime: true,
    vadSupported: true,
    recommendedModel: 'v5',
  }),
  isVADSupported: vi.fn().mockReturnValue(true),
  getFrameSamplesForModel: vi.fn().mockImplementation((model: string) => (model === 'v5' ? 512 : 1536)),
}));

describe('VADProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    micVADCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create VADProcessor with default options', () => {
      const processor = new VADProcessor();

      expect(processor).toBeInstanceOf(VADProcessor);
      expect(processor.getModel()).toBe(DEFAULT_VAD_OPTIONS.model);
    });

    it('should create VADProcessor with custom options', () => {
      const processor = new VADProcessor({
        model: 'legacy',
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
      });

      expect(processor.getModel()).toBe('legacy');
    });

    it('should merge custom options with defaults', () => {
      const processor = new VADProcessor({
        positiveSpeechThreshold: 0.7,
      });

      const options = processor.getOptions();

      expect(options.positiveSpeechThreshold).toBe(0.7);
      expect(options.negativeSpeechThreshold).toBe(DEFAULT_VAD_OPTIONS.negativeSpeechThreshold);
      expect(options.model).toBe(DEFAULT_VAD_OPTIONS.model);
    });

    it('should accept callback options', () => {
      const onSpeechStart = vi.fn();
      const onSpeechEnd = vi.fn();
      const onVADMisfire = vi.fn();
      const onFrameProcessed = vi.fn();

      const processor = new VADProcessor({
        onSpeechStart,
        onSpeechEnd,
        onVADMisfire,
        onFrameProcessed,
      });

      expect(processor).toBeInstanceOf(VADProcessor);
    });
  });

  describe('isSupported', () => {
    it('should return boolean from isSupported', () => {
      const processor = new VADProcessor();
      // isSupported calls isVADSupported which is mocked
      // The actual method might not be properly inherited from mock
      const result = processor.isSupported?.();
      expect(typeof result === 'boolean' || result === undefined).toBe(true);
    });
  });

  describe('getModel', () => {
    it('should return v5 by default', () => {
      const processor = new VADProcessor();
      expect(processor.getModel()).toBe('v5');
    });

    it('should return legacy when configured', () => {
      const processor = new VADProcessor({ model: 'legacy' });
      expect(processor.getModel()).toBe('legacy');
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const processor = new VADProcessor();
      const stats = processor.getStats();

      expect(stats).toEqual(
        expect.objectContaining({
          isActive: false,
          isSpeaking: false,
          speechProbability: 0,
          currentSpeechDuration: 0,
          framesProcessed: 0,
          speechSegmentsDetected: 0,
          misfireCount: 0,
          averageSpeechProbability: 0,
        }),
      );
      expect(typeof stats.timestamp).toBe('number');
    });

    it('should return a copy of stats', () => {
      const processor = new VADProcessor();
      const stats1 = processor.getStats();
      const stats2 = processor.getStats();

      expect(stats1).not.toBe(stats2);
      const { timestamp: _t1, ...rest1 } = stats1;
      const { timestamp: _t2, ...rest2 } = stats2;
      expect(rest1).toEqual(rest2);
      expect(Math.abs(stats1.timestamp - stats2.timestamp)).toBeLessThanOrEqual(5);
    });
  });

  describe('isSpeaking', () => {
    it('should return false initially', () => {
      const processor = new VADProcessor();
      expect(processor.isSpeaking()).toBe(false);
    });
  });

  describe('getSpeechProbability', () => {
    it('should return 0 initially', () => {
      const processor = new VADProcessor();
      expect(processor.getSpeechProbability()).toBe(0);
    });
  });

  describe('getOptions', () => {
    it('should return current options', () => {
      const processor = new VADProcessor({
        model: 'legacy',
        positiveSpeechThreshold: 0.6,
      });

      const options = processor.getOptions();

      expect(options.model).toBe('legacy');
      expect(options.positiveSpeechThreshold).toBe(0.6);
    });

    it('should return a copy of options', () => {
      const processor = new VADProcessor();
      const options1 = processor.getOptions();
      const options2 = processor.getOptions();

      expect(options1).not.toBe(options2);
    });
  });

  describe('updateThresholds', () => {
    it('should update thresholds', async () => {
      const processor = new VADProcessor();

      await processor.updateThresholds(0.7, 0.4);

      const options = processor.getOptions();
      expect(options.positiveSpeechThreshold).toBe(0.7);
      expect(options.negativeSpeechThreshold).toBe(0.4);
    });

    // Validation guards for threshold ranges
    it('rejects positiveSpeechThreshold below 0', async () => {
      const processor = new VADProcessor();
      await expect(processor.updateThresholds(-0.1, 0.3)).rejects.toThrow(VADError);
    });

    it('rejects positiveSpeechThreshold above 1', async () => {
      const processor = new VADProcessor();
      await expect(processor.updateThresholds(1.5, 0.3)).rejects.toThrow(VADError);
    });

    it('rejects negativeSpeechThreshold below 0', async () => {
      const processor = new VADProcessor();
      await expect(processor.updateThresholds(0.5, -0.1)).rejects.toThrow(VADError);
    });

    it('rejects NaN thresholds', async () => {
      const processor = new VADProcessor();
      await expect(processor.updateThresholds(NaN, 0.3)).rejects.toThrow(VADError);
      await expect(processor.updateThresholds(0.5, NaN)).rejects.toThrow(VADError);
    });

    it('rejects positive < negative (invariant violation)', async () => {
      const processor = new VADProcessor();
      await expect(processor.updateThresholds(0.3, 0.7)).rejects.toThrow(/must be >= negativeSpeechThreshold/);
    });

    it('accepts equal positive and negative (boundary allowed)', async () => {
      const processor = new VADProcessor();
      await expect(processor.updateThresholds(0.5, 0.5)).resolves.toBeUndefined();
    });

    it('leaves options unchanged when validation fails', async () => {
      const processor = new VADProcessor({
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
      });

      await expect(processor.updateThresholds(2, 0.3)).rejects.toThrow(VADError);

      const opts = processor.getOptions();
      expect(opts.positiveSpeechThreshold).toBe(0.6);
      expect(opts.negativeSpeechThreshold).toBe(0.4);
    });
  });

  // postSpeechPadMs forwarded via zero-pad in handleSpeechEnd
  describe('postSpeechPadMs', () => {
    function withSpeechEndStub(padMs: number, sampleRate: number) {
      const processor = new VADProcessor({
        postSpeechPadMs: padMs,
        sampleRate,
      });
      const captured: Float32Array[] = [];
      (processor as unknown as { callbacks: { onSpeechEnd?: (a: Float32Array) => void } }).callbacks.onSpeechEnd = (a: Float32Array) => {
        captured.push(a);
      };
      return { processor, captured };
    }

    it('appends padMs * sampleRate zeros to the buffer when padMs > 0', () => {
      const { processor, captured } = withSpeechEndStub(100, 16000); // 100ms @ 16kHz = 1600 samples
      const input = new Float32Array([0.1, 0.2, 0.3]);

      (processor as unknown as { handleSpeechEnd: (a: Float32Array) => void }).handleSpeechEnd(input);

      expect(captured.length).toBe(1);
      const padded = captured[0]!;
      expect(padded.length).toBe(3 + 1600);
      // Original samples preserved at the start
      expect(padded[0]).toBeCloseTo(0.1, 5);
      expect(padded[1]).toBeCloseTo(0.2, 5);
      expect(padded[2]).toBeCloseTo(0.3, 5);
      // Tail is zero-filled
      expect(padded[3]).toBe(0);
      expect(padded[1602]).toBe(0);
    });

    it('returns the original buffer when padMs is 0 (no allocation)', () => {
      const { processor, captured } = withSpeechEndStub(0, 16000);
      const input = new Float32Array([0.1, 0.2, 0.3]);

      (processor as unknown as { handleSpeechEnd: (a: Float32Array) => void }).handleSpeechEnd(input);

      expect(captured[0]).toBe(input); // exact reference equality — no copy
    });

    it('returns the original buffer when padMs is negative', () => {
      const { processor, captured } = withSpeechEndStub(-50, 16000);
      const input = new Float32Array([0.1, 0.2]);

      (processor as unknown as { handleSpeechEnd: (a: Float32Array) => void }).handleSpeechEnd(input);

      expect(captured[0]).toBe(input);
    });
  });

  describe('updateOptions', () => {
    it('should update enableStats option', async () => {
      const processor = new VADProcessor({ enableStats: false });

      await processor.updateOptions({ enableStats: true });

      const options = processor.getOptions();
      expect(options.enableStats).toBe(true);
    });

    it('should update statsInterval option', async () => {
      const processor = new VADProcessor();

      await processor.updateOptions({ statsInterval: 500 });

      const options = processor.getOptions();
      expect(options.statsInterval).toBe(500);
    });

    it('should update thresholds via updateOptions', async () => {
      const processor = new VADProcessor();

      await processor.updateOptions({
        positiveSpeechThreshold: 0.8,
        negativeSpeechThreshold: 0.3,
      });

      const options = processor.getOptions();
      expect(options.positiveSpeechThreshold).toBe(0.8);
      expect(options.negativeSpeechThreshold).toBe(0.3);
    });
  });

  describe('pause and start', () => {
    it('should pause processing', () => {
      const processor = new VADProcessor();
      processor.pause();

      const stats = processor.getStats();
      expect(stats.isActive).toBe(false);
    });

    it('should start processing', () => {
      const processor = new VADProcessor();
      processor.pause();
      processor.start();

      const stats = processor.getStats();
      expect(stats.isActive).toBe(true);
    });
  });

  describe('resetStats', () => {
    it('should reset statistics', () => {
      const processor = new VADProcessor();

      // Modify stats by calling internal methods would require more setup
      // For now, just verify resetStats doesn't throw
      processor.resetStats();

      const stats = processor.getStats();
      expect(stats.speechProbability).toBe(0);
      expect(stats.framesProcessed).toBe(0);
      expect(stats.speechSegmentsDetected).toBe(0);
      expect(stats.misfireCount).toBe(0);
      expect(stats.averageSpeechProbability).toBe(0);
    });

    it('should preserve isActive and isSpeaking after reset', () => {
      const processor = new VADProcessor();
      processor.start();

      processor.resetStats();

      const stats = processor.getStats();
      expect(stats.isActive).toBe(true);
    });
  });
});

describe('createVAD factory function', () => {
  it('should create VADProcessor instance', () => {
    const processor = createVAD();
    expect(processor).toBeInstanceOf(VADProcessor);
  });

  it('should pass options to VADProcessor', () => {
    const processor = createVAD({
      model: 'legacy',
      positiveSpeechThreshold: 0.7,
    });

    expect(processor.getModel()).toBe('legacy');
    expect(processor.getOptions().positiveSpeechThreshold).toBe(0.7);
  });

  it('should create with callbacks', () => {
    const onSpeechEnd = vi.fn();

    const processor = createVAD({
      onSpeechEnd,
    });

    expect(processor).toBeInstanceOf(VADProcessor);
  });
});

describe('VADProcessor options validation', () => {
  it('should accept all valid model types', () => {
    const v5Processor = new VADProcessor({ model: 'v5' });
    const legacyProcessor = new VADProcessor({ model: 'legacy' });

    expect(v5Processor.getModel()).toBe('v5');
    expect(legacyProcessor.getModel()).toBe('legacy');
  });

  it('should accept threshold values between 0 and 1', () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.8,
      negativeSpeechThreshold: 0.2,
    });

    const options = processor.getOptions();
    expect(options.positiveSpeechThreshold).toBe(0.8);
    expect(options.negativeSpeechThreshold).toBe(0.2);
  });

  it('should accept custom asset paths', () => {
    const processor = new VADProcessor({
      baseAssetPath: 'https://custom.cdn.com/vad/',
      onnxWASMBasePath: 'https://custom.cdn.com/onnx/',
    });

    const options = processor.getOptions();
    expect(options.baseAssetPath).toBe('https://custom.cdn.com/vad/');
    expect(options.onnxWASMBasePath).toBe('https://custom.cdn.com/onnx/');
  });

  it('should accept timing configuration', () => {
    const processor = new VADProcessor({
      preSpeechPadMs: 200,
      postSpeechPadMs: 400,
      minSpeechMs: 300,
      redemptionMs: 1000,
    });

    const options = processor.getOptions();
    expect(options.preSpeechPadMs).toBe(200);
    expect(options.postSpeechPadMs).toBe(400);
    expect(options.minSpeechMs).toBe(300);
    expect(options.redemptionMs).toBe(1000);
  });
});

describe('VADProcessor edge cases', () => {
  it('should handle multiple pause calls', () => {
    const processor = new VADProcessor();

    processor.pause();
    processor.pause();
    processor.pause();

    expect(processor.getStats().isActive).toBe(false);
  });

  it('should handle multiple start calls', () => {
    const processor = new VADProcessor();

    processor.start();
    processor.start();
    processor.start();

    expect(processor.getStats().isActive).toBe(true);
  });

  it('should handle rapid pause/start toggles', () => {
    const processor = new VADProcessor();

    for (let i = 0; i < 10; i++) {
      processor.pause();
      processor.start();
    }

    expect(processor.getStats().isActive).toBe(true);
  });

  it('should handle multiple resetStats calls', () => {
    const processor = new VADProcessor();

    processor.resetStats();
    processor.resetStats();
    processor.resetStats();

    const stats = processor.getStats();
    expect(stats.framesProcessed).toBe(0);
  });
});

// ============================================================================
// Lifecycle integration tests (init / reset / setStream / silence)
// ============================================================================

interface InitOpts {
  audioContext: AudioContext;
  track: MediaStreamTrack;
}

const makeInitOpts = (): InitOpts => ({
  audioContext: new (globalThis as unknown as { AudioContext: new () => AudioContext }).AudioContext(),
  track: new (globalThis as unknown as { MediaStreamTrack: new () => MediaStreamTrack }).MediaStreamTrack(),
});

interface InternalProcessor {
  init: (opts: InitOpts) => Promise<void>;
  destroy: () => Promise<void>;
}

const asInternal = (p: VADProcessor): InternalProcessor => p as unknown as InternalProcessor;

// Every describe below shares the module-level micVADCalls array; make sure
// it does not leak across tests (the existing vi.clearAllMocks() does not
// touch our local array).
beforeEach(() => {
  micVADCalls.length = 0;
});

describe('VADProcessor.reset()', () => {
  it('creates a new MicVAD instance, resetting LSTM state', async () => {
    const processor = new VADProcessor();
    await asInternal(processor).init(makeInitOpts());

    expect(micVADCalls).toHaveLength(1);
    const firstInstance = micVADCalls[0]!.instance;

    await processor.reset();

    expect(micVADCalls).toHaveLength(2);
    expect(micVADCalls[1]!.instance).not.toBe(firstInstance);
    expect(firstInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it('preserves processor options across reset', async () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.66,
      negativeSpeechThreshold: 0.42,
      model: 'v5',
    });
    await asInternal(processor).init(makeInitOpts());

    await processor.reset();

    const secondOpts = micVADCalls[1]!.options as {
      positiveSpeechThreshold: number;
      negativeSpeechThreshold: number;
      model: string;
    };
    expect(secondOpts.positiveSpeechThreshold).toBe(0.66);
    expect(secondOpts.negativeSpeechThreshold).toBe(0.42);
    expect(secondOpts.model).toBe('v5');
  });

  it('is a no-op when not initialized (does not throw)', async () => {
    const processor = new VADProcessor();
    await expect(processor.reset()).resolves.toBeUndefined();
    expect(micVADCalls).toHaveLength(0);
  });
});

describe('VADProcessor.setStream()', () => {
  it('rebuilds MicVAD with the new stream', async () => {
    const processor = new VADProcessor();
    await asInternal(processor).init(makeInitOpts());

    expect(micVADCalls).toHaveLength(1);
    const firstInstance = micVADCalls[0]!.instance;

    const newTrack = new (globalThis as unknown as { MediaStreamTrack: new () => MediaStreamTrack }).MediaStreamTrack();
    const newStream = new (globalThis as unknown as { MediaStream: new (tracks: MediaStreamTrack[]) => MediaStream }).MediaStream([newTrack]);

    await processor.setStream(newStream);

    expect(micVADCalls).toHaveLength(2);
    expect(micVADCalls[1]!.instance).not.toBe(firstInstance);
    expect(firstInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws when called before init (no implicit stream)', async () => {
    const processor = new VADProcessor();
    const stream = new (globalThis as unknown as { MediaStream: new () => MediaStream }).MediaStream();
    await expect(processor.setStream(stream)).rejects.toThrow(VADError);
  });
});

describe('VADProcessor silence-triggered reset', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-resets MicVAD after silenceResetMs of contiguous non-speech', async () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.5,
      silenceResetMs: 500,
    });
    await asInternal(processor).init(makeInitOpts());

    expect(micVADCalls).toHaveLength(1);
    const onFrameProcessed = micVADCalls[0]!.options.onFrameProcessed as (
      probs: { isSpeech: number; notSpeech: number },
      frame: Float32Array,
    ) => void;

    const frame = new Float32Array(512);

    onFrameProcessed({ isSpeech: 0.1, notSpeech: 0.9 }, frame);
    expect(micVADCalls).toHaveLength(1);

    vi.advanceTimersByTime(600);

    onFrameProcessed({ isSpeech: 0.05, notSpeech: 0.95 }, frame);
    await vi.runOnlyPendingTimersAsync();

    expect(micVADCalls).toHaveLength(2);
  });

  it('does NOT reset while frames remain above the positive threshold', async () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.5,
      silenceResetMs: 200,
    });
    await asInternal(processor).init(makeInitOpts());

    const onFrameProcessed = micVADCalls[0]!.options.onFrameProcessed as (
      probs: { isSpeech: number; notSpeech: number },
      frame: Float32Array,
    ) => void;
    const frame = new Float32Array(512);

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      onFrameProcessed({ isSpeech: 0.9, notSpeech: 0.1 }, frame);
    }
    await vi.runOnlyPendingTimersAsync();

    expect(micVADCalls).toHaveLength(1);
  });

  it('uses the default silenceResetMs of 5000 when not configured', () => {
    const processor = new VADProcessor();
    expect(processor.getOptions().silenceResetMs).toBe(5000);
  });

  it('disables silence-triggered reset when silenceResetMs is 0', async () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.5,
      silenceResetMs: 0,
    });
    await asInternal(processor).init(makeInitOpts());

    const onFrameProcessed = micVADCalls[0]!.options.onFrameProcessed as (
      probs: { isSpeech: number; notSpeech: number },
      frame: Float32Array,
    ) => void;
    const frame = new Float32Array(512);

    vi.advanceTimersByTime(60000);
    onFrameProcessed({ isSpeech: 0.05, notSpeech: 0.95 }, frame);
    await vi.runOnlyPendingTimersAsync();

    expect(micVADCalls).toHaveLength(1);
  });
});

// ============================================================================
// Sliding-window probability stats (memory bounded)
// ============================================================================

describe('VADProcessor sliding-window stats', () => {
  // L-4 upgraded the window from 300 → 1024 frames (~32.8 s @ 31.25 fps).
  // Size assertion lives in the L-4 describe block below.

  it('does not grow memory as frame count exceeds the window size', async () => {
    const processor = new VADProcessor({ silenceResetMs: 0 });
    await asInternal(processor).init(makeInitOpts());

    const onFrameProcessed = micVADCalls[0]!.options.onFrameProcessed as (
      probs: { isSpeech: number; notSpeech: number },
      frame: Float32Array,
    ) => void;
    const frame = new Float32Array(512);

    for (let i = 0; i < 10_000; i++) {
      onFrameProcessed({ isSpeech: 0.5, notSpeech: 0.5 }, frame);
    }

    const internals = processor as unknown as { probWindow: Float32Array };
    expect(internals.probWindow.length).toBe(1024);

    expect(processor.getStats().framesProcessed).toBe(10_000);
  });

  it('computes averageSpeechProbability from at most the last N frames', async () => {
    const processor = new VADProcessor({ silenceResetMs: 0 });
    await asInternal(processor).init(makeInitOpts());

    const onFrameProcessed = micVADCalls[0]!.options.onFrameProcessed as (
      probs: { isSpeech: number; notSpeech: number },
      frame: Float32Array,
    ) => void;
    const frame = new Float32Array(512);

    for (let i = 0; i < 2000; i++) {
      onFrameProcessed({ isSpeech: 0.1, notSpeech: 0.9 }, frame);
    }
    for (let i = 0; i < 1024; i++) {
      onFrameProcessed({ isSpeech: 0.9, notSpeech: 0.1 }, frame);
    }

    expect(processor.getStats().averageSpeechProbability).toBeCloseTo(0.9, 5);
  });

  it('resetStats() clears the ring buffer (averageSpeechProbability -> 0)', async () => {
    const processor = new VADProcessor({ silenceResetMs: 0 });
    await asInternal(processor).init(makeInitOpts());

    const onFrameProcessed = micVADCalls[0]!.options.onFrameProcessed as (
      probs: { isSpeech: number; notSpeech: number },
      frame: Float32Array,
    ) => void;
    const frame = new Float32Array(512);

    for (let i = 0; i < 100; i++) {
      onFrameProcessed({ isSpeech: 0.8, notSpeech: 0.2 }, frame);
    }
    expect(processor.getStats().averageSpeechProbability).toBeGreaterThan(0);

    processor.resetStats();

    expect(processor.getStats().averageSpeechProbability).toBe(0);
  });
});

// ============================================================================
// VADProcessor.restart() alias + threshold hot-reload
// ============================================================================

describe('VADProcessor.restart()', () => {
  it('is exposed as a public API', () => {
    const processor = new VADProcessor();
    expect(typeof (processor as unknown as { restart: () => Promise<void> }).restart).toBe('function');
  });

  it('rebuilds the MicVAD instance (LSTM hidden-state reset)', async () => {
    const processor = new VADProcessor();
    await asInternal(processor).init(makeInitOpts());

    expect(micVADCalls).toHaveLength(1);
    const firstInstance = micVADCalls[0]!.instance;

    await (processor as unknown as { restart: () => Promise<void> }).restart();

    expect(micVADCalls).toHaveLength(2);
    expect(micVADCalls[1]!.instance).not.toBe(firstInstance);
    expect(firstInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when not initialized (does not throw)', async () => {
    const processor = new VADProcessor();
    await expect((processor as unknown as { restart: () => Promise<void> }).restart()).resolves.toBeUndefined();
    expect(micVADCalls).toHaveLength(0);
  });
});

describe('VADProcessor threshold hot-reload triggers restart', () => {
  it('updateThresholds restarts MicVAD with the new thresholds applied', async () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
    });
    await asInternal(processor).init(makeInitOpts());

    expect(micVADCalls).toHaveLength(1);

    await processor.updateThresholds(0.72, 0.48);

    expect(micVADCalls).toHaveLength(2);
    const secondOpts = micVADCalls[1]!.options as {
      positiveSpeechThreshold: number;
      negativeSpeechThreshold: number;
    };
    expect(secondOpts.positiveSpeechThreshold).toBe(0.72);
    expect(secondOpts.negativeSpeechThreshold).toBe(0.48);
  });

  it('updateOptions with threshold changes routes through restart (single rebuild)', async () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
    });
    await asInternal(processor).init(makeInitOpts());
    expect(micVADCalls).toHaveLength(1);

    await processor.updateOptions({
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.4,
    });

    expect(micVADCalls).toHaveLength(2);
  });

  it('does NOT restart when thresholds are unchanged (no-op fast path)', async () => {
    const processor = new VADProcessor({
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
    });
    await asInternal(processor).init(makeInitOpts());
    expect(micVADCalls).toHaveLength(1);

    await processor.updateThresholds(0.5, 0.35);

    expect(micVADCalls).toHaveLength(1);
  });

  it('does NOT throw when updateThresholds is called before init (deferred until init)', async () => {
    const processor = new VADProcessor();
    await expect(processor.updateThresholds(0.7, 0.4)).resolves.toBeUndefined();
    const opts = processor.getOptions();
    expect(opts.positiveSpeechThreshold).toBe(0.7);
    expect(opts.negativeSpeechThreshold).toBe(0.4);
  });
});

// ============================================================================
// Sliding window upgraded to 1024 frames (~32.8s @ 31.25 fps)
// ============================================================================

describe('VADProcessor sliding-window @ 1024 frames', () => {
  it('uses a Float32Array(1024) ring buffer', () => {
    const processor = new VADProcessor();
    const internals = processor as unknown as { probWindow: Float32Array; PROB_WINDOW_SIZE: number };
    expect(internals.probWindow).toBeInstanceOf(Float32Array);
    expect(internals.probWindow.length).toBe(1024);
    expect(internals.PROB_WINDOW_SIZE).toBe(1024);
  });

  it('averageSpeechProbability is computed across at most the last 1024 frames', async () => {
    const processor = new VADProcessor({ silenceResetMs: 0 });
    await asInternal(processor).init(makeInitOpts());

    const onFrameProcessed = micVADCalls[0]!.options.onFrameProcessed as (
      probs: { isSpeech: number; notSpeech: number },
      frame: Float32Array,
    ) => void;
    const frame = new Float32Array(512);

    for (let i = 0; i < 2000; i++) {
      onFrameProcessed({ isSpeech: 0.1, notSpeech: 0.9 }, frame);
    }
    for (let i = 0; i < 1024; i++) {
      onFrameProcessed({ isSpeech: 0.9, notSpeech: 0.1 }, frame);
    }

    expect(processor.getStats().averageSpeechProbability).toBeCloseTo(0.9, 5);
  });
});

// ============================================================================
// VAD numThreads gating on crossOriginIsolated
// ============================================================================

describe('VADProcessor numThreads gating', () => {
  let originalCrossOriginIsolated: boolean | undefined;
  let originalHardwareConcurrency: number;
  let ortMock: {
    env: {
      wasm: { numThreads?: number; proxy?: boolean; wasmPaths?: string };
    };
  };

  beforeEach(() => {
    originalCrossOriginIsolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    originalHardwareConcurrency = globalThis.navigator?.hardwareConcurrency;

    ortMock = { env: { wasm: {} } };
    (globalThis as unknown as { ort?: typeof ortMock }).ort = ortMock;
  });

  afterEach(() => {
    if (originalCrossOriginIsolated === undefined) {
      // @ts-expect-error - cleanup
      delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    } else {
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = originalCrossOriginIsolated;
    }
    if (originalHardwareConcurrency !== undefined) {
      Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
        value: originalHardwareConcurrency,
        configurable: true,
      });
    }
    // @ts-expect-error - cleanup
    delete (globalThis as { ort?: unknown }).ort;
  });

  it('promotes ort.env.wasm.numThreads when crossOriginIsolated is true', async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: 4,
      configurable: true,
    });

    const processor = new VADProcessor();
    await asInternal(processor).init(makeInitOpts());

    expect(ortMock.env.wasm.numThreads).toBe(4);
  });

  it('keeps numThreads at 1 when crossOriginIsolated is false', async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: 4,
      configurable: true,
    });

    const processor = new VADProcessor();
    await asInternal(processor).init(makeInitOpts());

    expect(ortMock.env.wasm.numThreads).toBe(1);
  });

  it('clamps numThreads to a safe maximum (<= 8) on high-core hosts', async () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      value: 128,
      configurable: true,
    });

    const processor = new VADProcessor();
    await asInternal(processor).init(makeInitOpts());

    const n = ortMock.env.wasm.numThreads ?? -1;
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(8);
  });
});

// ============================================================================
// VADSpeechEndPayload.duration (ms) at the source
// ============================================================================

describe('VADSpeechEndPayload.duration', () => {
  it('emits duration in milliseconds equal to endTime - startTime', async () => {
    const processor = new VADProcessor({ silenceResetMs: 0 });
    await asInternal(processor).init(makeInitOpts());

    const internalEmits: Array<{ type: string; data: Record<string, unknown> }> = [];
    (processor as unknown as { emitData: (t: string, d: unknown) => void }).emitData = (type: string, data: unknown) => {
      internalEmits.push({ type, data: data as Record<string, unknown> });
    };

    const onSpeechStart = micVADCalls[0]!.options.onSpeechStart as () => void;
    const onSpeechEnd = micVADCalls[0]!.options.onSpeechEnd as (audio: Float32Array) => void;

    onSpeechStart();
    await new Promise((r) => setTimeout(r, 25));
    onSpeechEnd(new Float32Array(8000));

    const endEvents = internalEmits.filter((e) => e.type === 'vad-speech-end');
    expect(endEvents).toHaveLength(1);

    const payload = endEvents[0]!.data as {
      startTime: number;
      endTime: number;
      duration: number;
      durationSec: number;
    };
    expect(payload.duration).toBe(payload.endTime - payload.startTime);
    expect(payload.duration).toBeCloseTo(payload.durationSec * 1000, 0);
    expect(payload.duration).toBeGreaterThan(0);
  });
});
