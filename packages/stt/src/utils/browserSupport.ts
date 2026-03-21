/**
 * @arcaai/stt - Browser Support Detection
 *
 * Re-exports common browser detection from @arcaai/room.
 * STT-specific detection (WebGPU, WebSocket, Transformers.js) stays here.
 */

import {
  isBrowser,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  isAudioContextSupported,
  isAudioWorkletSupported,
  isMediaStreamTrackSupported,
  isSharedArrayBufferSupported,
} from '@arcaai/room';

import type { STTBrowserSupport, ComputeDevice, STTProviderType } from '../types/index.js';

// Re-export shared utilities from @arcaai/room
export {
  isBrowser,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  isAudioContextSupported,
  isAudioWorkletSupported,
  isMediaStreamTrackSupported,
  isSharedArrayBufferSupported,
};

// ============================================================================
// STT-Specific Feature Detection
// ============================================================================

/**
 * Check if WebAssembly is supported.
 */
export function isWebAssemblySupported(): boolean {
  if (!isBrowser()) return false;
  try {
    return (
      typeof WebAssembly === 'object' &&
      typeof WebAssembly.instantiate === 'function' &&
      typeof WebAssembly.compile === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Check if WebGPU is supported.
 */
export function isWebGPUSupported(): boolean {
  if (!isBrowser()) return false;
  try {
    return 'gpu' in navigator && navigator.gpu !== undefined;
  } catch {
    return false;
  }
}

/**
 * Check if WebGPU is available and can be used.
 * This performs a more thorough check by attempting to request an adapter.
 */
export async function isWebGPUAvailable(): Promise<boolean> {
  if (!isWebGPUSupported()) return false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown | null> } }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Check if WebSocket is supported.
 */
export function isWebSocketSupported(): boolean {
  if (!isBrowser()) return false;
  try {
    return typeof WebSocket !== 'undefined';
  } catch {
    return false;
  }
}

// ============================================================================
// Transformers.js Support
// ============================================================================

/**
 * Check if Transformers.js can run in this browser.
 * Requires WebAssembly at minimum.
 */
export function isTransformersJsSupported(): boolean {
  if (!isBrowser()) return false;

  if (!isWebAssemblySupported()) return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('async () => {}');
  } catch {
    return false;
  }

  return true;
}

// ============================================================================
// Comprehensive Support Check
// ============================================================================

/**
 * Get recommended compute device based on browser capabilities.
 */
export function getRecommendedDevice(): ComputeDevice {
  if (isWebGPUSupported()) {
    return 'webgpu';
  }
  if (isWebAssemblySupported()) {
    return 'wasm';
  }
  return 'wasm';
}

/**
 * Get recommended provider based on browser capabilities.
 */
export function getRecommendedProvider(): STTProviderType {
  if (isTransformersJsSupported()) {
    return 'local';
  }
  if (isWebSocketSupported()) {
    return 'remote';
  }
  return 'remote';
}

/**
 * Get comprehensive browser support information for STT.
 */
export function getSTTBrowserSupport(): STTBrowserSupport {
  const webAssembly = isWebAssemblySupported();
  const webGPU = isWebGPUSupported();
  const audioWorklet = isAudioWorkletSupported();
  const webSocket = isWebSocketSupported();
  const sharedArrayBuffer = isSharedArrayBufferSupported();
  const transformersJsSupported = isTransformersJsSupported();

  const localSupported = transformersJsSupported && isAudioContextSupported();
  const backendSupported = webSocket && isAudioContextSupported();

  let recommendedDevice: ComputeDevice = 'wasm';
  if (webGPU) {
    recommendedDevice = 'webgpu';
  }

  let recommendedProvider: STTProviderType = 'remote';
  if (localSupported) {
    recommendedProvider = 'local';
  }

  let unsupportedReason: string | undefined;
  if (!localSupported && !backendSupported) {
    if (!webAssembly) {
      unsupportedReason = 'WebAssembly is not supported in this browser';
    } else if (!isAudioContextSupported()) {
      unsupportedReason = 'AudioContext is not supported in this browser';
    } else if (!webSocket) {
      unsupportedReason = 'WebSocket is not supported in this browser';
    } else {
      unsupportedReason = 'Required browser features are not available';
    }
  }

  return {
    webAssembly,
    webGPU,
    audioWorklet,
    webSocket,
    sharedArrayBuffer,
    transformersJsSupported,
    recommendedDevice,
    recommendedProvider,
    localSupported,
    backendSupported,
    unsupportedReason,
  };
}

/**
 * Check if STT is supported in the current browser.
 */
export function isSTTSupported(): boolean {
  const support = getSTTBrowserSupport();
  return support.localSupported || support.backendSupported;
}

/**
 * Log browser support information to console for debugging.
 */
export function logBrowserSupport(): void {
  const support = getSTTBrowserSupport();
  console.group('@arcaai/stt Browser Support');
  console.log('WebAssembly:', support.webAssembly);
  console.log('WebGPU:', support.webGPU);
  console.log('AudioWorklet:', support.audioWorklet);
  console.log('WebSocket:', support.webSocket);
  console.log('SharedArrayBuffer:', support.sharedArrayBuffer);
  console.log('Transformers.js:', support.transformersJsSupported);
  console.log('Local STT:', support.localSupported);
  console.log('Remote STT:', support.backendSupported);
  console.log('Recommended Device:', support.recommendedDevice);
  console.log('Recommended Provider:', support.recommendedProvider);
  if (support.unsupportedReason) {
    console.warn('Unsupported Reason:', support.unsupportedReason);
  }
  console.groupEnd();
}
