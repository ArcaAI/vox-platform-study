/**
 * Real-WASM smoke test.
 *
 * Drives the actual `@jitsi/rnnoise-wasm` binary loaded from `node_modules`
 * via Node `fs` through one full frame round-trip. Lives in its own file so
 * the `vi.doMock` calls in `upstreamLoader.test.ts` cannot leak into it.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createRnnoiseModule } from '../processors/rnnoiseModule.js';

describe('createRnnoiseModule smoke (real WASM)', () => {
  it('drives the real @jitsi/rnnoise-wasm binary through one frame round-trip', async () => {
    const wasmPath = fileURLToPath(import.meta.resolve('@jitsi/rnnoise-wasm/dist/rnnoise.wasm'));
    const wasm = readFileSync(wasmPath);
    const buffer = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);

    const module = await createRnnoiseModule({ wasmBinary: buffer });

    const state = module.rnnoise_create();
    expect(state).toBeGreaterThan(0);

    const FRAME = 480;
    const inputPtr = module.malloc(FRAME * 4);
    const outputPtr = module.malloc(FRAME * 4);
    expect(inputPtr).toBeGreaterThan(0);
    expect(outputPtr).toBeGreaterThan(0);

    const input = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) input[i] = Math.sin(i * 0.05) * 0.1;
    module.heapF32.set(input, inputPtr / 4);

    const vad = module.rnnoise_process_frame(state, outputPtr, inputPtr);
    expect(vad).toBeGreaterThanOrEqual(0);
    expect(vad).toBeLessThanOrEqual(1);

    module.free(inputPtr);
    module.free(outputPtr);
    module.rnnoise_destroy(state);
  });
});
