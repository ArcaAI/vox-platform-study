/**
 * @arcaai/noise-filter — RNNoise WASM module adapter (main thread)
 *
 * Thin wrapper around the official `@jitsi/rnnoise-wasm` Emscripten loader
 * (`createRNNWasmModule`). Provides a uniform `RnnoiseModule` interface that
 * `RNNoiseProcessor` consumes; the worklet thread builds the same interface
 * via `workletRnnoiseLoader.ts` because AudioWorklets cannot import npm
 * packages at runtime.
 */

/**
 * Uniform RNNoise WASM interface backed by either the upstream loader
 * (main thread) or the worklet's hand-port.
 *
 * The `heapF32` view becomes stale if the WASM linear memory grows;
 * implementations refresh the view internally so callers always get a
 * live `Float32Array<ArrayBuffer>`.
 */
export interface RnnoiseModule {
  /** Live `Float32Array` view of the WASM linear memory. */
  readonly heapF32: Float32Array<ArrayBuffer>;
  rnnoise_create(): number;
  rnnoise_destroy(state: number): void;
  rnnoise_process_frame(state: number, outputPtr: number, inputPtr: number): number;
  malloc(size: number): number;
  free(ptr: number): void;
}

export interface CreateRnnoiseModuleOptions {
  wasmBinary: ArrayBuffer;
}

/**
 * Build an `RnnoiseModule` by delegating to the upstream Emscripten loader.
 * The binary is consumed verbatim (no network fetch performed here).
 */
export async function createRnnoiseModule(options: CreateRnnoiseModuleOptions): Promise<RnnoiseModule> {
  const { createRNNWasmModule } = await import('@jitsi/rnnoise-wasm');
  const wasm = await createRNNWasmModule({ wasmBinary: options.wasmBinary });

  return {
    get heapF32(): Float32Array<ArrayBuffer> {
      return wasm.HEAPF32 as Float32Array<ArrayBuffer>;
    },
    rnnoise_create: () => wasm._rnnoise_create(),
    rnnoise_destroy: (state) => wasm._rnnoise_destroy(state),
    rnnoise_process_frame: (state, output, input) => wasm._rnnoise_process_frame(state, output, input),
    malloc: (size) => wasm._malloc(size),
    free: (ptr) => wasm._free(ptr),
  };
}
