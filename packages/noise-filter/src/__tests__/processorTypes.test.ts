/**
 * TASK-269 — HIGH-5
 *
 * Compile-time type checks for the `process()` signature: tight enough that
 * consumers see correct types under TypeScript strict mode, lax enough that
 * both `Float32Array<ArrayBuffer>` (WASM-backed views) and
 * `Float32Array<ArrayBufferLike>` (AudioWorklet inputs) work as inputs.
 */

import { describe, it, expectTypeOf } from 'vitest';

import { RNNoiseProcessor } from '../processors/RNNoiseProcessor.js';
import type { RNNoiseResult } from '../types/index.js';

describe('RNNoiseProcessor.process — types (HIGH-5)', () => {
  it('accepts a Float32Array<ArrayBuffer> input/output and returns RNNoiseResult', () => {
    const proc = new RNNoiseProcessor();
    const input = new Float32Array(new ArrayBuffer(480 * 4));
    const output = new Float32Array(new ArrayBuffer(480 * 4));

    type ProcessReturn = ReturnType<typeof proc.process>;
    expectTypeOf<ProcessReturn>().toEqualTypeOf<RNNoiseResult>();

    type ProcessArgs = Parameters<typeof proc.process>;
    expectTypeOf<ProcessArgs[0]>().toMatchTypeOf<Float32Array<ArrayBufferLike>>();
    expectTypeOf<ProcessArgs[1]>().toMatchTypeOf<Float32Array<ArrayBufferLike>>();

    const r = proc.process(input, output);
    expectTypeOf(r.samples).toMatchTypeOf<Float32Array<ArrayBufferLike>>();
    expectTypeOf(r.vadProbability).toBeNumber();
  });

  it('RNNoiseResult.samples uses ArrayBufferLike to span both WASM and standard buffers', () => {
    expectTypeOf<RNNoiseResult['samples']>().toMatchTypeOf<Float32Array<ArrayBufferLike>>();
  });
});
