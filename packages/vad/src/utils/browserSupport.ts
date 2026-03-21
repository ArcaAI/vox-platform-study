/**
 * @arcaai/vad - Browser Support Utilities
 *
 * Re-exports common browser detection from @arcaai/room.
 * VAD-specific detection (ONNX, iOS, cross-origin isolation) stays here.
 */

import {
  isBrowser,
  isSafari,
  getSafariVersion,
  isSafariVersionSupported,
  isGetUserMediaSupported,
  isAudioContextSupported,
  isAudioWorkletSupported,
  isMediaStreamTrackSupported,
  isSharedArrayBufferSupported,
} from '@arcaai/room';

import type { VADBrowserSupport, VADModel } from '../types/index.js';

// Re-export shared utilities from @arcaai/room
export {
  isBrowser,
  isSafari,
  getSafariVersion,
  isGetUserMediaSupported,
  isAudioContextSupported,
  isAudioWorkletSupported,
  isMediaStreamTrackSupported,
  isSharedArrayBufferSupported,
};

// ============================================================================
// VAD-Specific Feature Detection
// ============================================================================

/**
 * Check if WebAssembly is supported.
 */
export function isWebAssemblySupported(): boolean {
  if (!isBrowser()) return false;

  try {
    if (typeof WebAssembly === 'object') {
      const module = new WebAssembly.Module(
        new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      );
      return module instanceof WebAssembly.Module;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Check if cross-origin isolation is enabled.
 * Required for SharedArrayBuffer and multi-threaded WASM.
 */
export function isCrossOriginIsolated(): boolean {
  if (!isBrowser()) return false;

  try {
    return (
      typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
    );
  } catch {
    return false;
  }
}

/**
 * Check if ScriptProcessorNode is available (fallback).
 * @deprecated ScriptProcessorNode is deprecated, but kept for fallback support.
 */
export function isScriptProcessorSupported(): boolean {
  if (!isBrowser()) return false;

  try {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioContextConstructor) return false;

    return 'createScriptProcessor' in AudioContextConstructor.prototype;
  } catch {
    return false;
  }
}

/**
 * Check if Safari version supports AudioWorklet (17.4+).
 * Uses room's isSafariVersionSupported under the hood.
 */
export function isSafariAudioWorkletSupported(): boolean {
  return isSafariVersionSupported() && isSafari();
}

/**
 * Detect iOS device.
 */
export function isIOS(): boolean {
  if (!isBrowser()) return false;

  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Check if ONNX Runtime Web is likely to be supported.
 */
export function isONNXRuntimeSupported(): boolean {
  if (!isWebAssemblySupported()) return false;
  return true;
}

/**
 * Check if Silero VAD can run in the current browser.
 */
export function isVADSupported(): boolean {
  const hasWasm = isWebAssemblySupported();
  const hasAudioContext = isAudioContextSupported();
  const hasWorkletOrFallback =
    isAudioWorkletSupported() || isScriptProcessorSupported();

  return hasWasm && hasAudioContext && hasWorkletOrFallback;
}

/**
 * Get the recommended VAD model based on browser capabilities.
 */
export function getRecommendedModel(): VADModel {
  if (isSafari() && !isSafariAudioWorkletSupported()) {
    return 'legacy';
  }

  if (isIOS()) {
    return 'legacy';
  }

  return 'v5';
}

/**
 * Get frame size for the specified model.
 */
export function getFrameSamplesForModel(model: VADModel): number {
  return model === 'v5' ? 512 : 1536;
}

/**
 * Get comprehensive browser support information for VAD.
 */
export function getVADBrowserSupport(): VADBrowserSupport {
  const webAssembly = isWebAssemblySupported();
  const audioWorklet = isAudioWorkletSupported();
  const sharedArrayBuffer = isSharedArrayBufferSupported();
  const onnxRuntime = isONNXRuntimeSupported();
  const audioContext = isAudioContextSupported();
  const scriptProcessor = isScriptProcessorSupported();

  const vadSupported =
    webAssembly && audioContext && (audioWorklet || scriptProcessor);

  let unsupportedReason: string | undefined;

  if (!audioContext) {
    unsupportedReason = 'AudioContext not supported';
  } else if (!webAssembly) {
    unsupportedReason = 'WebAssembly not supported';
  } else if (!audioWorklet && !scriptProcessor) {
    unsupportedReason = 'No audio processing API available';
  }

  const recommendedModel = getRecommendedModel();

  return {
    webAssembly,
    audioWorklet,
    sharedArrayBuffer,
    onnxRuntime,
    vadSupported,
    unsupportedReason,
    recommendedModel,
  };
}

/**
 * Check if the browser supports multi-threaded ONNX Runtime.
 */
export function isMultiThreadedONNXSupported(): boolean {
  return (
    isWebAssemblySupported() &&
    isSharedArrayBufferSupported() &&
    isCrossOriginIsolated()
  );
}

/**
 * Log browser support info for debugging.
 */
export function logVADBrowserSupport(): void {
  if (!isBrowser()) {
    console.log('[VAD] Not running in browser environment');
    return;
  }

  const support = getVADBrowserSupport();

  console.log('[VAD] Browser Support:');
  console.log(`  WebAssembly: ${support.webAssembly ? 'Yes' : 'No'}`);
  console.log(`  AudioWorklet: ${support.audioWorklet ? 'Yes' : 'No'}`);
  console.log(`  SharedArrayBuffer: ${support.sharedArrayBuffer ? 'Yes' : 'No'}`);
  console.log(`  Cross-Origin Isolated: ${isCrossOriginIsolated() ? 'Yes' : 'No'}`);
  console.log(`  ONNX Runtime: ${support.onnxRuntime ? 'Yes' : 'No'}`);
  console.log(`  VAD Supported: ${support.vadSupported ? 'Yes' : 'No'}`);
  console.log(`  Recommended Model: ${support.recommendedModel}`);
  console.log(`  Multi-threaded ONNX: ${isMultiThreadedONNXSupported() ? 'Yes' : 'No'}`);

  if (support.unsupportedReason) {
    console.warn(`  Limitation: ${support.unsupportedReason}`);
  }

  if (isSafari()) {
    console.log(`  Safari Version: ${getSafariVersion()}`);
    console.log(
      `  Safari AudioWorklet: ${isSafariAudioWorkletSupported() ? 'Yes' : 'No'}`
    );
  }

  if (isIOS()) {
    console.log('  Running on iOS device');
  }
}
