/**
 * TASK-269 — CRIT-3 (worklet path)
 *
 * The AudioWorklet cannot import `@jitsi/rnnoise-wasm` at runtime, so the
 * worklet uses a hand-port of the upstream Emscripten runtime that targets
 * the binary's *actual* import object (`{ a: { a: resize_heap, b: memcpy_big } }`)
 * and accesses exports through the binary's stable minified names.
 *
 * This test pins the worklet loader against the real `rnnoise.wasm` binary
 * to detect drift in the upstream package.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { instantiateRnnoiseInWorklet } from '../processors/workletRnnoiseLoader.js';

describe('instantiateRnnoiseInWorklet (manual worklet loader)', () => {
  it('returns a working RnnoiseModule against the real WASM binary', async () => {
    const wasmPath = fileURLToPath(import.meta.resolve('@jitsi/rnnoise-wasm/dist/rnnoise.wasm'));
    const wasm = readFileSync(wasmPath);
    const binary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);

    const module = await instantiateRnnoiseInWorklet(binary);

    expect(typeof module.rnnoise_create).toBe('function');
    expect(typeof module.rnnoise_process_frame).toBe('function');
    expect(typeof module.rnnoise_destroy).toBe('function');
    expect(typeof module.malloc).toBe('function');
    expect(typeof module.free).toBe('function');

    const state = module.rnnoise_create();
    expect(state).toBeGreaterThan(0);

    const FRAME = 480;
    const inputPtr = module.malloc(FRAME * 4);
    const outputPtr = module.malloc(FRAME * 4);

    const input = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) input[i] = Math.cos(i * 0.03) * 0.2;
    module.heapF32.set(input, inputPtr / 4);

    const vad = module.rnnoise_process_frame(state, outputPtr, inputPtr);
    expect(vad).toBeGreaterThanOrEqual(0);
    expect(vad).toBeLessThanOrEqual(1);

    const output = module.heapF32.subarray(outputPtr / 4, outputPtr / 4 + FRAME);
    expect(output.length).toBe(FRAME);

    module.free(inputPtr);
    module.free(outputPtr);
    module.rnnoise_destroy(state);
  });
});
