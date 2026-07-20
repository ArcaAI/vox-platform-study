/**
 * @arcaai/med-ner - Browser Support Detection
 *
 * Utilities for detecting browser capabilities for Medical NER.
 */

import type { MedNERBrowserSupport, MedNERDevice } from '../types/index.js';

/**
 * Check if running in a browser environment.
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Check if WebAssembly is supported.
 */
export function isWebAssemblySupported(): boolean {
  if (!isBrowser()) return true; // Assume Node.js supports WASM

  try {
    if (typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function') {
      const module = new WebAssembly.Module(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
      return module instanceof WebAssembly.Module;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if IndexedDB is supported (for model caching).
 */
export function isIndexedDBSupported(): boolean {
  if (!isBrowser()) return false;

  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Check if Fetch API is supported.
 */
export function isFetchSupported(): boolean {
  if (!isBrowser()) return true; // Node.js 18+ has fetch

  return typeof fetch === 'function';
}

/**
 * Check if the browser is Safari.
 */
export function isSafari(): boolean {
  if (!isBrowser()) return false;

  const ua = navigator.userAgent;
  return /^((?!chrome|android).)*safari/i.test(ua);
}

/**
 * Get Safari version if applicable.
 */
export function getSafariVersion(): string | undefined {
  if (!isSafari()) return undefined;

  const match = navigator.userAgent.match(/Version\/(\d+(\.\d+)?)/);
  return match?.[1];
}

/**
 * Check if running on iOS.
 */
export function isIOS(): boolean {
  if (!isBrowser()) return false;

  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Detect device memory (if available).
 */
export function getDeviceMemory(): number | undefined {
  if (!isBrowser()) return undefined;

  // deviceMemory is a non-standard API
  const nav = navigator as Navigator & { deviceMemory?: number };
  return nav.deviceMemory;
}

/**
 * Get the number of logical CPU cores.
 */
export function getHardwareConcurrency(): number {
  if (!isBrowser()) {
    // In Node.js, use os.cpus()
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- this package builds for the browser; a static `import 'os'` would fail bundling there, so the Node-only fallback must stay a runtime require() guarded by the surrounding try/catch
      const os = require('os');
      return os.cpus().length;
    } catch {
      return 4; // Default fallback
    }
  }

  return navigator.hardwareConcurrency || 4;
}

/**
 * Get recommended quantization type based on device capabilities.
 */
export function getRecommendedDtype(): 'fp32' | 'fp16' | 'q8' | 'q4' {
  if (!isBrowser()) {
    // Server-side: use full precision
    return 'fp32';
  }

  const memory = getDeviceMemory();
  const cores = getHardwareConcurrency();

  // Low-end devices: use most aggressive quantization
  if (memory !== undefined && memory <= 2) {
    return 'q4';
  }

  // Mid-range devices or iOS: use q8
  if ((memory !== undefined && memory <= 4) || isIOS()) {
    return 'q8';
  }

  // High-end devices with many cores: can handle fp16
  if (memory !== undefined && memory >= 8 && cores >= 8) {
    return 'fp16';
  }

  // Default: q8 is a good balance
  return 'q8';
}

/**
 * Check if the WebGPU API is exposed on `navigator`.
 *
 * Presence of `navigator.gpu` does NOT guarantee that a usable adapter
 * exists — use {@link getRecommendedDevice} to actually request one.
 */
export function isWebGPUSupported(): boolean {
  if (!isBrowser()) return false;
  return typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined';
}

/**
 * Probe the runtime for the best compute backend for the NER pipeline.
 *
 * Order of preference:
 * 1. WebGPU, if `navigator.gpu.requestAdapter()` resolves to an adapter.
 * 2. WASM (always available where Transformers.js is supported).
 *
 * Any error (no `navigator.gpu`, no adapter, exception from the adapter
 * request) silently falls back to `'wasm'`.
 */
export async function getRecommendedDevice(): Promise<MedNERDevice> {
  if (!isBrowser()) return 'wasm';

  const nav = navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown> };
  };
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    return 'wasm';
  }

  try {
    const adapter = await nav.gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/**
 * Check if Medical NER is supported in the current environment.
 */
export function isMedNERSupported(): boolean {
  const support = getMedNERBrowserSupport();
  return support.nerSupported;
}

/**
 * Get comprehensive browser support information for Medical NER.
 */
export function getMedNERBrowserSupport(): MedNERBrowserSupport {
  const webAssembly = isWebAssemblySupported();
  const indexedDB = isIndexedDBSupported();
  const fetch = isFetchSupported();
  const recommendedDtype = getRecommendedDtype();
  const webGPU = isWebGPUSupported();

  // NER requires WebAssembly and Fetch
  const nerSupported = webAssembly && fetch;

  let unsupportedReason: string | undefined;
  if (!webAssembly) {
    unsupportedReason = 'WebAssembly is not supported in this browser';
  } else if (!fetch) {
    unsupportedReason = 'Fetch API is not supported in this browser';
  }

  return {
    webAssembly,
    indexedDB,
    fetch,
    nerSupported,
    unsupportedReason,
    recommendedDtype,
    webGPU,
  };
}

/**
 * Log browser support information to console.
 */
export function logBrowserSupport(): void {
  const support = getMedNERBrowserSupport();

  console.group('🏥 @arcaai/med-ner Browser Support');
  console.log('WebAssembly:', support.webAssembly ? '✅' : '❌');
  console.log('IndexedDB:', support.indexedDB ? '✅' : '❌');
  console.log('Fetch API:', support.fetch ? '✅' : '❌');
  console.log('NER Supported:', support.nerSupported ? '✅' : '❌');
  console.log('Recommended dtype:', support.recommendedDtype);

  if (isBrowser()) {
    const memory = getDeviceMemory();
    const cores = getHardwareConcurrency();
    console.log('Device Memory:', memory ? `${memory}GB` : 'Unknown');
    console.log('CPU Cores:', cores);
    console.log('Safari:', isSafari() ? `Yes (${getSafariVersion()})` : 'No');
    console.log('iOS:', isIOS() ? 'Yes' : 'No');
  }

  if (support.unsupportedReason) {
    console.warn('⚠️ Unsupported:', support.unsupportedReason);
  }

  console.groupEnd();
}
