/**
 * @arcaai/noise-filter — WASM asset resolver
 *
 * Resolves the default RNNoise WASM URL from the package's bundled asset
 * at `<pkg>/assets/rnnoise.wasm`, eliminating the previous runtime CDN
 * dependency on `cdn.jsdelivr.net`.
 *
 * The asset is shipped at the package root (`<pkg>/assets/rnnoise.wasm`) so
 * the same `new URL('../assets/rnnoise.wasm', import.meta.url)` expression
 * resolves to the correct on-disk location whether evaluated against the
 * TypeScript source (`src/wasmAsset.ts`) or the bundled output
 * (`dist/index.js`). The tsup build copies the binary from
 * `@jitsi/rnnoise-wasm/dist/rnnoise.wasm` via `onSuccess`.
 *
 * Consumers needing to self-host the binary can override
 * `NoiseFilterOptions.wasmPath` or import the asset via the
 * `@arcaai/noise-filter/wasm` subpath export.
 */

/**
 * URL of the bundled `rnnoise.wasm` binary.
 *
 * @returns A `file://`/`http(s)://` URL string pointing at the WASM binary.
 */
export function getDefaultWasmUrl(): string {
  return new URL('../assets/rnnoise.wasm', import.meta.url).href;
}
