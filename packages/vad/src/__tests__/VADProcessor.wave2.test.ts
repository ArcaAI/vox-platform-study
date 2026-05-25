/**
 * @arcaai/vad — Wave 2 (TASK-304 Wave 2) bug fix tests.
 *
 * Covers:
 *   • W2-VAD-1 — `startStatsEmission` is idempotent: calling
 *               `updateOptions({ enableStats: true })` twice while stats are already
 *               running does NOT leak the previous `setInterval` handle. This is the
 *               VAD analog of the NoiseFilter MED-10 fix landed in TASK-304 Wave 1.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VADProcessor } from '../processors/VADProcessor.js';

vi.mock('@arcaai/room', () => {
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
    async init() {}
    async destroy() {}
    async enable() {}
    async disable() {}
  }
  return {
    BaseProcessor: MockBaseProcessor,
    ProcessorEvent: { Data: 'data', Error: 'error', Enabled: 'enabled', Disabled: 'disabled' },
  };
});

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: vi.fn(async () => ({
      start: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
    })),
  },
}));

describe('VADProcessor — Wave 2 (TASK-304 Wave 2)', () => {
  let processor: VADProcessor;

  beforeEach(() => {
    vi.useFakeTimers();
    processor = new VADProcessor({ enableStats: false });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await processor.destroy();
  });

  describe('W2-VAD-1 startStatsEmission is idempotent', () => {
    it('clears the previous timer before installing a new one (no setInterval leak)', async () => {
      const setSpy = vi.spyOn(globalThis, 'setInterval');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');

      // First enable: schedules timer #1.
      await processor.updateOptions({ enableStats: true });
      const initialSetCount = setSpy.mock.calls.length;
      expect(initialSetCount).toBeGreaterThanOrEqual(1);
      const previousHandle = setSpy.mock.results[initialSetCount - 1]?.value;

      // Second enable while still enabled: should clear the previous handle
      // before scheduling timer #2.
      await processor.updateOptions({ enableStats: true });

      expect(clearSpy).toHaveBeenCalledWith(previousHandle);
      expect(setSpy.mock.calls.length).toBeGreaterThan(initialSetCount);

      // Disable to clean up.
      await processor.updateOptions({ enableStats: false });
    });
  });
});
