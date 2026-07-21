/**
 * Verifies that the package uses the official `@jitsi/rnnoise-wasm`
 * loader (`createRNNWasmModule`) rather than a hand-rolled
 * `WebAssembly.instantiate` with the wrong import object.
 *
 * Includes one smoke test that drives the loader against the real
 * `rnnoise.wasm` binary via Node `fs`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('createRnnoiseModule (main-thread adapter)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('delegates to @jitsi/rnnoise-wasm createRNNWasmModule', async () => {
    const fakeFactory = vi.fn(async () => ({
      _rnnoise_create: vi.fn(() => 0xabcd),
      _rnnoise_destroy: vi.fn(),
      _rnnoise_process_frame: vi.fn(() => 0.7),
      _malloc: vi.fn((size: number) => (size > 0 ? 1024 : 0)),
      _free: vi.fn(),
      HEAPF32: new Float32Array(1024 * 1024),
    }));

    vi.doMock('@jitsi/rnnoise-wasm', () => ({
      createRNNWasmModule: fakeFactory,
      createRNNWasmModuleSync: vi.fn(),
    }));

    const { createRnnoiseModule: fresh } = await import('../processors/rnnoiseModule.js');
    const binary = new ArrayBuffer(8);
    const module = await fresh({ wasmBinary: binary });

    expect(fakeFactory).toHaveBeenCalledTimes(1);
    const factoryArg = fakeFactory.mock.calls[0]![0] as { wasmBinary: ArrayBuffer };
    expect(factoryArg.wasmBinary).toBe(binary);

    expect(module.rnnoise_create()).toBe(0xabcd);
    expect(module.rnnoise_process_frame(0xabcd, 64, 128)).toBe(0.7);
    expect(module.malloc(1920)).toBe(1024);
    module.free(1024);
    module.rnnoise_destroy(0xabcd);
  });

  it('exposes a Float32Array<ArrayBuffer> heapF32 view', async () => {
    const heap = new Float32Array(new ArrayBuffer(4 * 1024));
    vi.doMock('@jitsi/rnnoise-wasm', () => ({
      createRNNWasmModule: vi.fn(async () => ({
        _rnnoise_create: vi.fn(() => 1),
        _rnnoise_destroy: vi.fn(),
        _rnnoise_process_frame: vi.fn(() => 0),
        _malloc: vi.fn(() => 0),
        _free: vi.fn(),
        HEAPF32: heap,
      })),
      createRNNWasmModuleSync: vi.fn(),
    }));

    const { createRnnoiseModule: fresh } = await import('../processors/rnnoiseModule.js');
    const module = await fresh({ wasmBinary: new ArrayBuffer(0) });

    expect(module.heapF32).toBe(heap);
    expect(module.heapF32.buffer).toBeInstanceOf(ArrayBuffer);
  });
});

// (smoke test against the real `@jitsi/rnnoise-wasm` binary lives in
// `upstreamLoader.smoke.test.ts` so module mocks from this file do not
// leak into it).
