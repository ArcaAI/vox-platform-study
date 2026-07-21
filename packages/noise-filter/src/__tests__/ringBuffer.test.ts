/**
 * The processor must emit gap-free output once the priming frame has
 * been processed, regardless of input quantum size. Trailing partial
 * frames are zero-padded.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RNNOISE_FRAME_SIZE } from '../processors/RNNoiseProcessor.js';

interface MockedModule {
  _malloc: ReturnType<typeof vi.fn>;
  _free: ReturnType<typeof vi.fn>;
  _rnnoise_create: ReturnType<typeof vi.fn>;
  _rnnoise_destroy: ReturnType<typeof vi.fn>;
  _rnnoise_process_frame: ReturnType<typeof vi.fn>;
  HEAPF32: Float32Array;
}

/**
 * Build a mock RNNoise WASM module whose `_rnnoise_process_frame` copies
 * the input buffer to the output buffer multiplied by a constant `gain`,
 * so we can verify which input samples reach the output and detect gaps.
 */
function makeMockModule(gain: number): MockedModule {
  const heap = new Float32Array(new ArrayBuffer(4 * 1024 * 1024));
  let nextPtr = 1024;
  return {
    HEAPF32: heap,
    _malloc: vi.fn((size: number) => {
      const ptr = nextPtr;
      nextPtr += size + 16;
      return ptr;
    }),
    _free: vi.fn(),
    _rnnoise_create: vi.fn(() => 0xdead),
    _rnnoise_destroy: vi.fn(),
    _rnnoise_process_frame: vi.fn((_state: number, outputPtr: number, inputPtr: number) => {
      for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
        heap[outputPtr / 4 + i] = heap[inputPtr / 4 + i]! * gain;
      }
      return 0.5;
    }),
  };
}

describe.each([256, 480, 512, 1024])('ring buffer with input quantum %i', (quantum) => {
  let module: MockedModule;

  beforeEach(() => {
    vi.resetModules();
    module = makeMockModule(1.0);
    vi.doMock('@jitsi/rnnoise-wasm', () => ({
      createRNNWasmModule: vi.fn(async () => module),
      createRNNWasmModuleSync: vi.fn(),
    }));
  });

  it('emits exactly input-length samples per process call', async () => {
    const { RNNoiseProcessor: Fresh } = await import('../processors/RNNoiseProcessor.js');
    const proc = new Fresh();
    // Force RNNoise output (level=high → multiplier=1.0 keeps WASM output as-is)
    proc.setLevel('high');
    await proc.init(new ArrayBuffer(8));

    const totalInputSamples = quantum * 20;
    const input = new Float32Array(totalInputSamples);
    for (let i = 0; i < totalInputSamples; i++) input[i] = i + 1;

    let consumed = 0;
    while (consumed < totalInputSamples) {
      const chunk = input.subarray(consumed, consumed + quantum);
      const out = new Float32Array(chunk.length);
      const result = proc.process(chunk, out);
      expect(result.samples.length).toBe(chunk.length);
      consumed += chunk.length;
    }
    expect(consumed).toBe(totalInputSamples);

    proc.destroy();
  });

  it('produces gap-free output after the priming frame', async () => {
    const { RNNoiseProcessor: Fresh } = await import('../processors/RNNoiseProcessor.js');
    const proc = new Fresh();
    proc.setLevel('high');
    await proc.init(new ArrayBuffer(8));

    const totalInputSamples = quantum * 20;
    const input = new Float32Array(totalInputSamples);
    for (let i = 0; i < totalInputSamples; i++) input[i] = i + 1; // strictly positive, monotone

    const output = new Float32Array(totalInputSamples);
    let consumed = 0;
    while (consumed < totalInputSamples) {
      const chunk = input.subarray(consumed, consumed + quantum);
      const out = output.subarray(consumed, consumed + chunk.length);
      proc.process(chunk, out);
      consumed += chunk.length;
    }

    // After the priming frame, every sample comes from the WASM output buffer
    // which (in our mock) mirrors the input multiplied by 1. None should be
    // an unrelated zero in the steady-state region.
    // Steady-state starts after `priming` samples have been produced.
    const priming = RNNOISE_FRAME_SIZE;
    let zeros = 0;
    for (let i = priming; i < totalInputSamples - quantum; i++) {
      if (output[i] === 0) zeros++;
    }
    expect(zeros).toBe(0);

    proc.destroy();
  });

  it('keeps output monotone (no out-of-order frames)', async () => {
    const { RNNoiseProcessor: Fresh } = await import('../processors/RNNoiseProcessor.js');
    const proc = new Fresh();
    proc.setLevel('high');
    await proc.init(new ArrayBuffer(8));

    const totalInputSamples = quantum * 30;
    const input = new Float32Array(totalInputSamples);
    for (let i = 0; i < totalInputSamples; i++) input[i] = i + 1;

    const output = new Float32Array(totalInputSamples);
    let consumed = 0;
    while (consumed < totalInputSamples) {
      const chunk = input.subarray(consumed, consumed + quantum);
      const out = output.subarray(consumed, consumed + chunk.length);
      proc.process(chunk, out);
      consumed += chunk.length;
    }

    // The output during steady-state should be strictly increasing because
    // input is monotone and the WASM mock is the identity.
    const priming = RNNOISE_FRAME_SIZE;
    for (let i = priming + 1; i < totalInputSamples - quantum; i++) {
      expect(output[i]).toBeGreaterThan(output[i - 1]!);
    }

    proc.destroy();
  });
});
