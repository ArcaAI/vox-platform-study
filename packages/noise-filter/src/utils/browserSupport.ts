/**
 * @arcaai/noise-filter - Browser Support Utilities
 *
 * Re-exports common browser detection from @arcaai/room.
 * Noise-filter-specific detection (RNNoise, native NS, processing mode) stays here.
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

import type { NoiseFilterBrowserSupport } from '../types/index.js';

// Re-export shared utilities from @arcaai/room
export {
  isBrowser,
  isSafari,
  getSafariVersion,
  isAudioContextSupported,
  isAudioWorkletSupported,
  isMediaStreamTrackSupported,
  isSharedArrayBufferSupported,
};

// ============================================================================
// Noise-Filter-Specific Feature Detection
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
 * Check if ScriptProcessorNode is available (fallback).
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
 * Check if WebRTC native noise suppression is supported.
 */
export function isNativeNoiseSuppressionSupported(): boolean {
  if (!isBrowser()) return false;

  try {
    if (!navigator.mediaDevices?.getSupportedConstraints) return false;

    const constraints = navigator.mediaDevices.getSupportedConstraints();
    return constraints.noiseSuppression === true;
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
 * Check if RNNoise (full feature) is supported.
 */
export function isRNNoiseSupported(): boolean {
  const hasWasm = isWebAssemblySupported();
  const hasAudioContext = isAudioContextSupported();
  const hasWorkletOrFallback =
    isAudioWorkletSupported() || isScriptProcessorSupported();

  return hasWasm && hasAudioContext && hasWorkletOrFallback;
}

/**
 * Get comprehensive browser support information.
 */
export function getNoiseFilterBrowserSupport(): NoiseFilterBrowserSupport {
  const webAssembly = isWebAssemblySupported();
  const audioWorklet = isAudioWorkletSupported();
  const sharedArrayBuffer = isSharedArrayBufferSupported();
  const nativeNS = isNativeNoiseSuppressionSupported();
  const audioContext = isAudioContextSupported();
  const scriptProcessor = isScriptProcessorSupported();

  const rnnoiseSupported =
    webAssembly && audioContext && (audioWorklet || scriptProcessor);

  const nativeFallbackAvailable = nativeNS && audioContext;

  let unsupportedReason: string | undefined;

  if (!audioContext) {
    unsupportedReason = 'AudioContext not supported';
  } else if (!webAssembly && !nativeNS) {
    unsupportedReason = 'Neither WebAssembly nor native noise suppression supported';
  } else if (!audioWorklet && !scriptProcessor) {
    unsupportedReason = 'No audio processing API available';
  }

  return {
    webAssembly,
    audioWorklet,
    sharedArrayBuffer,
    rnnoiseSupported,
    nativeFallbackAvailable,
    unsupportedReason,
  };
}

/**
 * Get recommended processing mode based on device capabilities.
 */
export function getRecommendedProcessingMode(): 'quality' | 'performance' {
  if (!isBrowser()) return 'quality';

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const cores = navigator.hardwareConcurrency ?? 2;

  if (isMobile || cores < 4) {
    return 'performance';
  }

  return 'quality';
}

/**
 * Log browser support info for debugging.
 */
export function logBrowserSupport(): void {
  if (!isBrowser()) {
    console.log('[NoiseFilter] Not running in browser environment');
    return;
  }

  const support = getNoiseFilterBrowserSupport();

  console.log('[NoiseFilter] Browser Support:');
  console.log(`  WebAssembly: ${support.webAssembly ? 'Yes' : 'No'}`);
  console.log(`  AudioWorklet: ${support.audioWorklet ? 'Yes' : 'No'}`);
  console.log(`  SharedArrayBuffer: ${support.sharedArrayBuffer ? 'Yes' : 'No'}`);
  console.log(`  RNNoise Supported: ${support.rnnoiseSupported ? 'Yes' : 'No'}`);
  console.log(`  Native Fallback: ${support.nativeFallbackAvailable ? 'Yes' : 'No'}`);

  if (support.unsupportedReason) {
    console.warn(`  Limitation: ${support.unsupportedReason}`);
  }

  if (isSafari()) {
    console.log(`  Safari Version: ${getSafariVersion()}`);
    console.log(
      `  Safari AudioWorklet: ${isSafariAudioWorkletSupported() ? 'Yes' : 'No'}`
    );
  }
}
