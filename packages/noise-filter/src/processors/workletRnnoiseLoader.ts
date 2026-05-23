/**
 * @arcaai/noise-filter — Manual RNNoise WASM loader for AudioWorklet
 *
 * AudioWorklet processors cannot import npm modules at runtime, so the
 * worklet thread cannot call `createRNNWasmModule` from `@jitsi/rnnoise-wasm`.
 * This file is a minimal hand-port of the relevant subset of the upstream
 * Emscripten runtime, pinned to the import object that the bundled
 * `rnnoise.wasm` (v0.2.1) actually requires:
 *
 *     { a: { a: _emscripten_resize_heap, b: _emscripten_memcpy_big } }
 *
 * It also depends on the binary's stable single-letter export names:
 *
 *     c — exported `WebAssembly.Memory`
 *     d — `___wasm_call_ctors`
 *     e — `_rnnoise_init`
 *     f — `_rnnoise_create`
 *     g — `_malloc`
 *     h — `_rnnoise_destroy`
 *     i — `_free`
 *     j — `_rnnoise_process_frame`
 *
 * The two import functions implement the same semantics as the upstream
 * loader; see `node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.js`.
 *
 * The TS source is shipped via `dist/worklets/rnnoise.worklet.js` and is
 * mirrored verbatim into the inline string in `worklets/worklet-loader.ts`
 * (the runtime blob URL). Keep the two in sync.
 *
 * TASK-269 — CRIT-3 (worklet path).
 */

import type { RnnoiseModule } from './rnnoiseModule.js';

interface RnnoiseExports {
  c: WebAssembly.Memory;
  d: () => void;
  e: (state: number) => number;
  f: () => number;
  g: (size: number) => number;
  h: (state: number) => void;
  i: (ptr: number) => void;
  j: (state: number, output: number, input: number) => number;
}

export async function instantiateRnnoiseInWorklet(wasmBinary: ArrayBuffer): Promise<RnnoiseModule> {
  let heapU8: Uint8Array<ArrayBuffer>;
  let heapF32: Float32Array<ArrayBuffer>;

  const refreshViews = (): void => {
    heapU8 = new Uint8Array(memory.buffer);
    heapF32 = new Float32Array(memory.buffer);
  };

  const emscripten_memcpy_big = (dest: number, src: number, num: number): void => {
    heapU8.copyWithin(dest, src, src + num);
  };

  const emscripten_resize_heap = (requestedSize: number): 0 | 1 => {
    try {
      const oldSize = memory.buffer.byteLength;
      const requested = requestedSize >>> 0;
      const delta = Math.max(0, Math.ceil((requested - oldSize) / 65536));
      memory.grow(delta);
      refreshViews();
      return 1;
    } catch {
      return 0;
    }
  };

  const importObject = {
    a: {
      a: emscripten_resize_heap,
      b: emscripten_memcpy_big,
    },
  };

  const { instance } = await WebAssembly.instantiate(wasmBinary, importObject);
  const exports = instance.exports as unknown as RnnoiseExports;

  const memory: WebAssembly.Memory = exports.c;
  refreshViews();
  exports.d();

  return {
    get heapF32(): Float32Array<ArrayBuffer> {
      if (heapF32.buffer !== memory.buffer) refreshViews();
      return heapF32;
    },
    rnnoise_create: () => exports.f(),
    rnnoise_destroy: (state) => exports.h(state),
    rnnoise_process_frame: (state, output, input) => exports.j(state, output, input),
    malloc: (size) => exports.g(size),
    free: (ptr) => exports.i(ptr),
  };
}
