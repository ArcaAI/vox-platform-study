/**
 * @arcaai/vad - Pinned dependency versions and derived CDN paths
 *
 * Single source of truth for the `@ricky0123/vad-web` and `onnxruntime-web`
 * versions used at runtime when the consumer falls back to the jsDelivr CDN.
 *
 * These constants MUST stay in sync with `package.json`:
 *   - `dependencies["@ricky0123/vad-web"]`
 *   - `devDependencies["onnxruntime-web"]`
 *
 * The unit test in `__tests__/constants.test.ts` enforces the invariant; bump
 * both versions and the constants together.
 *
 * Background: previously the default CDN paths pointed at
 * `vad-web@0.0.29` and `onnxruntime-web@1.22.0` while the installed
 * packages were `^0.0.30` and `^1.24.3`. The ONNX Runtime WASM ABI is not
 * stable across minor versions, which made inference silently fail in
 * self-hosted defaults.
 */

/**
 * Installed version of `@ricky0123/vad-web`. Used to build the default
 * `baseAssetPath` when the consumer does not provide one.
 */
export const VAD_WEB_VERSION = '0.0.30';

/**
 * Installed version of `onnxruntime-web`. Used to build the default
 * `onnxWASMBasePath` when the consumer does not provide one.
 */
export const ORT_WEB_VERSION = '1.27.0';

/**
 * Default jsDelivr URL for `@ricky0123/vad-web` assets (worklet + ONNX model).
 * Always derive new paths from `VAD_WEB_VERSION`, never hard-code a version.
 *
 * Prefer self-hosting these assets in production; supply `baseAssetPath` via
 * `VADOptions` to override.
 */
export const DEFAULT_BASE_ASSET_PATH = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`;

/**
 * Default jsDelivr URL for `onnxruntime-web` WASM binaries.
 * Always derive new paths from `ORT_WEB_VERSION`, never hard-code a version.
 *
 * Prefer self-hosting these binaries in production; supply `onnxWASMBasePath`
 * via `VADOptions` to override.
 */
export const DEFAULT_ONNX_WASM_BASE_PATH = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/`;
