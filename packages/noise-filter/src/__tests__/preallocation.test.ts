/**
 * TASK-269 — CRIT-1
 *
 * Asserts that the audio-thread hot path does not call `_malloc`/`_free`
 * per frame. Buffers must be allocated once at init and freed only at
 * destroy.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RNNoiseProcessor, RNNOISE_FRAME_SIZE } from '../processors/RNNoiseProcessor.js';

interface MockedModule {
  _malloc: ReturnType<typeof vi.fn>;
  _free: ReturnType<typeof vi.fn>;
  _rnnoise_create: ReturnType<typeof vi.fn>;
  _rnnoise_destroy: ReturnType<typeof vi.fn>;
  _rnnoise_process_frame: ReturnType<typeof vi.fn>;
  HEAPF32: Float32Array;
}

function makeMockModule(): MockedModule {
  let nextPtr = 1024;
  const heap = new Float32Array(new ArrayBuffer(4 * 1024 * 1024));
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
    _rnnoise_process_frame: vi.fn(() => 0.5),
  };
}

describe('RNNoiseProcessor — preallocation (CRIT-1)', () => {
  let module: MockedModule;

  beforeEach(() => {
    vi.resetModules();
    module = makeMockModule();
    vi.doMock('@jitsi/rnnoise-wasm', () => ({
      createRNNWasmModule: vi.fn(async () => module),
      createRNNWasmModuleSync: vi.fn(),
    }));
  });

  it('allocates exactly two WASM buffers at init', async () => {
    const { RNNoiseProcessor: Fresh } = await import('../processors/RNNoiseProcessor.js');
    const proc = new Fresh();

    await proc.init(new ArrayBuffer(8));

    expect(module._malloc).toHaveBeenCalledTimes(2);
    expect(module._malloc).toHaveBeenNthCalledWith(1, RNNOISE_FRAME_SIZE * 4);
    expect(module._malloc).toHaveBeenNthCalledWith(2, RNNOISE_FRAME_SIZE * 4);
    expect(module._free).not.toHaveBeenCalled();

    proc.destroy();
  });

  it('does not call _malloc or _free during 10 000 process() calls', async () => {
    const { RNNoiseProcessor: Fresh } = await import('../processors/RNNoiseProcessor.js');
    const proc = new Fresh();
    await proc.init(new ArrayBuffer(8));

    const mallocBefore = module._malloc.mock.calls.length;
    const freeBefore = module._free.mock.calls.length;

    const input = new Float32Array(RNNOISE_FRAME_SIZE);
    const output = new Float32Array(RNNOISE_FRAME_SIZE);
    for (let i = 0; i < 10_000; i++) {
      proc.process(input, output);
    }

    expect(module._malloc.mock.calls.length).toBe(mallocBefore);
    expect(module._free.mock.calls.length).toBe(freeBefore);
    expect(module._rnnoise_process_frame).toHaveBeenCalledTimes(10_000);

    proc.destroy();
  });

  it('frees both buffers exactly once at destroy', async () => {
    const { RNNoiseProcessor: Fresh } = await import('../processors/RNNoiseProcessor.js');
    const proc = new Fresh();
    await proc.init(new ArrayBuffer(8));

    expect(module._free).not.toHaveBeenCalled();
    proc.destroy();
    expect(module._free).toHaveBeenCalledTimes(2);
    expect(module._rnnoise_destroy).toHaveBeenCalledTimes(1);
  });

  it('subsequent destroy() calls are no-ops (no double free)', async () => {
    const { RNNoiseProcessor: Fresh } = await import('../processors/RNNoiseProcessor.js');
    const proc = new Fresh();
    await proc.init(new ArrayBuffer(8));

    proc.destroy();
    proc.destroy();
    proc.destroy();

    expect(module._free).toHaveBeenCalledTimes(2);
    expect(module._rnnoise_destroy).toHaveBeenCalledTimes(1);
  });
});
