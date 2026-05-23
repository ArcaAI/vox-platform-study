/**
 * Type declarations for @jitsi/rnnoise-wasm (0.2.x).
 *
 * The upstream package is a compiled Emscripten module with the symbols
 * documented below. Names match the official `dist/rnnoise.js` glue
 * code; the underscore prefix is the Emscripten convention.
 */

declare module '@jitsi/rnnoise-wasm' {
  export interface RNNWasmModule {
    HEAPF32: Float32Array;
    HEAPU8: Uint8Array;
    _rnnoise_create: () => number;
    _rnnoise_destroy: (state: number) => void;
    _rnnoise_init: (state: number) => number;
    _rnnoise_process_frame: (state: number, output: number, input: number) => number;
    _malloc: (size: number) => number;
    _free: (ptr: number) => void;
  }

  export interface CreateRNNWasmModuleOptions {
    wasmBinary?: ArrayBuffer | Uint8Array;
    locateFile?: (path: string, prefix: string) => string;
  }

  /**
   * Async loader. Pass `{ wasmBinary }` to skip network fetch and
   * supply the binary yourself.
   */
  export function createRNNWasmModule(options?: CreateRNNWasmModuleOptions): Promise<RNNWasmModule>;

  /**
   * Sync loader. The WASM binary is embedded as base64 inside the JS file
   * (~1.9 MB). Useful for AudioWorklet contexts that cannot await imports.
   */
  export function createRNNWasmModuleSync(options?: CreateRNNWasmModuleOptions): RNNWasmModule;
}
