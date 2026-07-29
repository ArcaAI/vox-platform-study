/**
 * @arcaai/stt - STT capture worklet loader tests
 *
 * Verifies the worklet loader registers via blob URL, caches across
 * AudioContexts, and exposes a non-empty processor source.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STT_CAPTURE_PROCESSOR_NAME,
  DEFAULT_STT_CAPTURE_FRAME_MS,
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

interface PostedFrame {
  data: Float32Array;
  transfer: ArrayBuffer[];
}

interface WorkletProcessorHarness {
  /** Drive one render quantum through the processor. */
  process(channel: Float32Array): boolean;
  /** Deliver a control message to the processor's port. */
  postControl(message: unknown): void;
  /** Frames posted by the processor, in order. */
  posted: PostedFrame[];
}

/**
 * Instantiate the inline worklet source in a sandbox that fakes the
 * `AudioWorkletGlobalScope` (base class, `registerProcessor`, `sampleRate`)
 * so the processor's runtime behavior can be exercised in vitest.
 */
function instantiateWorkletProcessor(opts: { frameMs?: number; sampleRate?: number } = {}): WorkletProcessorHarness {
  const posted: PostedFrame[] = [];

  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (data: Float32Array, transfer?: ArrayBuffer[]) => {
        posted.push({ data, transfer: transfer ?? [] });
      },
    };
  }

  let RegisteredCtor: (new (options?: unknown) => { port: FakeAudioWorkletProcessor['port']; process(inputs: Float32Array[][]): boolean }) | null =
    null;
  const registerProcessor = (_name: string, ctor: typeof RegisteredCtor) => {
    RegisteredCtor = ctor;
  };

  const factory = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', __testing__.generateWorkletSource());
  factory(FakeAudioWorkletProcessor, registerProcessor, opts.sampleRate ?? 16000);

  if (!RegisteredCtor) {
    throw new Error('worklet source did not call registerProcessor');
  }
  const instance = new RegisteredCtor(opts.frameMs === undefined ? undefined : { processorOptions: { frameMs: opts.frameMs } });

  return {
    process: (channel) => instance.process([[channel]]),
    postControl: (message) => instance.port.onmessage?.({ data: message }),
    posted,
  };
}

/** A 128-sample render quantum filled with a ramp starting at `start`. */
function makeQuantum(start: number, length = 128): Float32Array {
  const quantum = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    quantum[i] = start + i;
  }
  return quantum;
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

describe('STT Capture Worklet frame coalescing', () => {
  it('exports an 80ms default frame size', () => {
    expect(DEFAULT_STT_CAPTURE_FRAME_MS).toBe(80);
  });

  it('accumulates quanta and posts nothing below the 80ms threshold', () => {
    // 16 kHz · 80 ms = 1280 samples = 10 × 128-sample quanta.
    const harness = instantiateWorkletProcessor({ sampleRate: 16000 });

    for (let i = 0; i < 9; i++) {
      harness.process(makeQuantum(i * 128));
    }

    expect(harness.posted).toHaveLength(0);
  });

  it('posts one coalesced in-order frame when the threshold fills', () => {
    const harness = instantiateWorkletProcessor({ sampleRate: 16000 });

    for (let i = 0; i < 10; i++) {
      harness.process(makeQuantum(i * 128));
    }

    expect(harness.posted).toHaveLength(1);
    const frame = harness.posted[0]!.data;
    expect(frame.length).toBe(1280);
    for (let i = 0; i < frame.length; i++) {
      expect(frame[i]).toBe(i);
    }
    // Buffer must ride the transfer list (zero-copy to the main thread).
    expect(harness.posted[0]!.transfer).toContain(frame.buffer);
  });

  it('honors a custom frameMs via processorOptions', () => {
    // 16 kHz · 40 ms = 640 samples = 5 quanta.
    const harness = instantiateWorkletProcessor({ sampleRate: 16000, frameMs: 40 });

    for (let i = 0; i < 4; i++) {
      harness.process(makeQuantum(i * 128));
    }
    expect(harness.posted).toHaveLength(0);

    harness.process(makeQuantum(4 * 128));
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]!.data.length).toBe(640);
  });

  it('scales the threshold with the worklet sampleRate', () => {
    // 48 kHz · 80 ms = 3840 samples = 30 quanta.
    const harness = instantiateWorkletProcessor({ sampleRate: 48000 });

    for (let i = 0; i < 29; i++) {
      harness.process(makeQuantum(i * 128));
    }
    expect(harness.posted).toHaveLength(0);

    harness.process(makeQuantum(29 * 128));
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]!.data.length).toBe(3840);
  });

  it('keeps emitting in-order frames across buffer swaps (no loss, no reorder)', () => {
    const harness = instantiateWorkletProcessor({ sampleRate: 16000 });

    // 25 quanta = 3200 samples → two full 1280-sample frames + 640 buffered.
    for (let i = 0; i < 25; i++) {
      harness.process(makeQuantum(i * 128));
    }

    expect(harness.posted).toHaveLength(2);
    const all = [...harness.posted[0]!.data, ...harness.posted[1]!.data];
    expect(all.length).toBe(2560);
    for (let i = 0; i < all.length; i++) {
      expect(all[i]).toBe(i);
    }
  });

  it('flush message posts the partial remainder so trailing audio is never lost', () => {
    const harness = instantiateWorkletProcessor({ sampleRate: 16000 });

    for (let i = 0; i < 3; i++) {
      harness.process(makeQuantum(i * 128));
    }
    expect(harness.posted).toHaveLength(0);

    harness.postControl({ type: 'flush' });

    expect(harness.posted).toHaveLength(1);
    const frame = harness.posted[0]!.data;
    expect(frame.length).toBe(384);
    for (let i = 0; i < frame.length; i++) {
      expect(frame[i]).toBe(i);
    }

    // Remainder was consumed — a second flush posts nothing.
    harness.postControl({ type: 'flush' });
    expect(harness.posted).toHaveLength(1);
  });

  it('setEnabled(false) flushes the remainder, then suppresses emission', () => {
    const harness = instantiateWorkletProcessor({ sampleRate: 16000 });

    harness.process(makeQuantum(0));
    harness.process(makeQuantum(128));
    harness.postControl({ type: 'setEnabled', enabled: false });

    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]!.data.length).toBe(256);

    // While disabled, incoming audio is ignored entirely.
    for (let i = 0; i < 20; i++) {
      harness.process(makeQuantum(0));
    }
    expect(harness.posted).toHaveLength(1);

    // Re-enable: accumulation starts fresh.
    harness.postControl({ type: 'setEnabled', enabled: true });
    for (let i = 0; i < 10; i++) {
      harness.process(makeQuantum(i * 128));
    }
    expect(harness.posted).toHaveLength(2);
    expect(harness.posted[1]!.data.length).toBe(1280);
  });

  it('handles oversized input blocks by splitting across frames', () => {
    const harness = instantiateWorkletProcessor({ sampleRate: 16000 });

    // One 1500-sample block (> 1280 threshold) → one full frame + 220 buffered.
    harness.process(makeQuantum(0, 1500));

    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]!.data.length).toBe(1280);

    harness.postControl({ type: 'flush' });
    expect(harness.posted).toHaveLength(2);
    expect(harness.posted[1]!.data.length).toBe(220);
    expect(harness.posted[1]!.data[0]).toBe(1280);
  });
});
