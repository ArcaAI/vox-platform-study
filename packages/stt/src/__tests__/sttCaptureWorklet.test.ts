/**
 * @arcaai/stt - STT capture worklet loader tests (TASK-270, C-3)
 *
 * Verifies the worklet loader registers via blob URL, caches across
 * AudioContexts, and exposes a non-empty processor source.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STT_CAPTURE_PROCESSOR_NAME,
  registerSTTCaptureWorklet,
  isSTTCaptureWorkletRegistered,
  cleanupSTTCaptureWorkletResources,
  __testing__,
} from '../worklets/stt-capture.worklet.js';

function makeContextWithWorklet(): { ctx: AudioContext; addModule: ReturnType<typeof vi.fn> } {
  const addModule = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    destination: {},
    audioWorklet: { addModule },
  } as unknown as AudioContext;
  return { ctx, addModule };
}

describe('STT Capture Worklet Loader', () => {
  beforeEach(() => {
    cleanupSTTCaptureWorkletResources();
  });

  afterEach(() => {
    cleanupSTTCaptureWorkletResources();
  });

  it('exposes the documented processor name constant', () => {
    expect(STT_CAPTURE_PROCESSOR_NAME).toBe('stt-capture-worklet-processor');
  });

  it('worklet source registers the processor under the constant name', () => {
    const source = __testing__.generateWorkletSource();
    expect(source).toContain('registerProcessor');
    expect(source).toContain(STT_CAPTURE_PROCESSOR_NAME);
    expect(source).toContain('class STTCaptureProcessor');
  });

  it('worklet source transfers frame buffer to avoid copy', () => {
    const source = __testing__.generateWorkletSource();
    // Transfer list pattern: `this.port.postMessage(frame, [frame.buffer])`
    expect(source).toMatch(/postMessage\(\s*frame\s*,\s*\[\s*frame\.buffer\s*\]\s*\)/);
  });

  it('registerSTTCaptureWorklet calls audioWorklet.addModule once per context', async () => {
    const { ctx, addModule } = makeContextWithWorklet();

    await registerSTTCaptureWorklet(ctx);
    await registerSTTCaptureWorklet(ctx);

    expect(addModule).toHaveBeenCalledTimes(1);
    expect(isSTTCaptureWorkletRegistered(ctx)).toBe(true);
  });

  it('isSTTCaptureWorkletRegistered returns false before registration', () => {
    const { ctx } = makeContextWithWorklet();
    expect(isSTTCaptureWorkletRegistered(ctx)).toBe(false);
  });
});
