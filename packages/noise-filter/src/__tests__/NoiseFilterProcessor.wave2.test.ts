/**
 * @arcaai/noise-filter — bug fix tests.
 *
 * Covers:
 *   • `NoiseFilterProcessor.updateOptions({ noiseCancellation })` actually
 *               propagates the toggle to the worklet / fallback processor. Prior to
 *               this fix the field was stored in `this.options` only; the audio kept
 *               being filtered (or kept passing through) regardless.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoiseFilterProcessor } from '../processors/NoiseFilterProcessor.js';

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

vi.mock('../worklets/worklet-loader.js', () => ({
  registerRNNoiseWorklet: vi.fn(),
  createRNNoiseWorkletNode: vi.fn(),
  isWorkletRegistered: vi.fn(() => false),
}));

interface WorkletNodeStub {
  port: { postMessage: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
}

interface RnnoiseStub {
  setEnabled: ReturnType<typeof vi.fn>;
  setLevel: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

describe('NoiseFilterProcessor — Wave 2 (TASK-304 Wave 2)', () => {
  let processor: NoiseFilterProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new NoiseFilterProcessor({ noiseCancellation: true, noiseCancellationLevel: 'high' });
  });

  afterEach(async () => {
    await processor.destroy();
  });

  function attachWorkletStub(p: NoiseFilterProcessor): WorkletNodeStub {
    const stub: WorkletNodeStub = { port: { postMessage: vi.fn() }, disconnect: vi.fn() };
    (p as unknown as { workletNode: WorkletNodeStub }).workletNode = stub;
    return stub;
  }

  describe('W2-NF-1 updateOptions({ noiseCancellation }) propagates the toggle', () => {
    it('forwards setEnabled:false to the worklet when disabling at runtime', async () => {
      const workletNode = attachWorkletStub(processor);

      await processor.updateOptions({ noiseCancellation: false });

      expect(processor.getOptions().noiseCancellation).toBe(false);
      expect(workletNode.port.postMessage).toHaveBeenCalledWith({ type: 'setEnabled', enabled: false });
    });

    it('forwards setEnabled:true to the worklet when re-enabling at runtime', async () => {
      const workletNode = attachWorkletStub(processor);

      // First disable, then re-enable so the test is not order-dependent.
      await processor.updateOptions({ noiseCancellation: false });
      workletNode.port.postMessage.mockClear();

      await processor.updateOptions({ noiseCancellation: true });

      expect(processor.getOptions().noiseCancellation).toBe(true);
      expect(workletNode.port.postMessage).toHaveBeenCalledWith({ type: 'setEnabled', enabled: true });
    });

    it('forwards the toggle to the ScriptProcessor fallback when no worklet is active', async () => {
      const rnnoise: RnnoiseStub = {
        setEnabled: vi.fn(),
        setLevel: vi.fn(),
        getStats: vi.fn(),
        destroy: vi.fn(),
      };
      (processor as unknown as { rnnoiseProcessor: RnnoiseStub | null }).rnnoiseProcessor = rnnoise;

      await processor.updateOptions({ noiseCancellation: false });

      expect(rnnoise.setEnabled).toHaveBeenCalledWith(false);
      expect(processor.getOptions().noiseCancellation).toBe(false);
    });

    it('does not call setEnabled when noiseCancellation is omitted from updateOptions', async () => {
      const workletNode = attachWorkletStub(processor);

      await processor.updateOptions({ noiseCancellationLevel: 'low' });

      const setEnabledCalls = workletNode.port.postMessage.mock.calls.filter(
        ([msg]) => (msg as { type: string }).type === 'setEnabled',
      );
      expect(setEnabledCalls).toHaveLength(0);
    });
  });
});
