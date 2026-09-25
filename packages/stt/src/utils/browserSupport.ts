/**
 * @arcaai/stt - Browser Support Detection
 *
 * Re-exports common browser detection from @arcaai/room.
 * STT-specific detection (WebSocket, backend streaming) stays here.
 *
 * TASK-1006 — the local (in-browser Whisper) capability checks (WebGPU,
 * Transformers.js, compute-device recommendation) were removed alongside the
 * local provider: the browser never runs a model (TASK-865).
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

import type { STTBrowserSupport } from '../types/index.js';

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
// Comprehensive Support Check
// ============================================================================

/**
 * Get comprehensive browser support information for STT.
 */
export function getSTTBrowserSupport(): STTBrowserSupport {
  const audioWorklet = isAudioWorkletSupported();
  const webSocket = isWebSocketSupported();
  const sharedArrayBuffer = isSharedArrayBufferSupported();

  const backendSupported = webSocket && isAudioContextSupported();

  let unsupportedReason: string | undefined;
  if (!backendSupported) {
    if (!isAudioContextSupported()) {
      unsupportedReason = 'AudioContext is not supported in this browser';
    } else if (!webSocket) {
      unsupportedReason = 'WebSocket is not supported in this browser';
    } else {
      unsupportedReason = 'Required browser features are not available';
    }
  }

  return {
    audioWorklet,
    webSocket,
    sharedArrayBuffer,
    backendSupported,
    unsupportedReason,
  };
}

/**
 * Check if STT is supported in the current browser.
 */
export function isSTTSupported(): boolean {
  const support = getSTTBrowserSupport();
  return support.backendSupported;
}

/**
 * Log browser support information to console for debugging.
 */
export function logBrowserSupport(): void {
  const support = getSTTBrowserSupport();
  console.group('@arcaai/stt Browser Support');
  console.log('AudioWorklet:', support.audioWorklet);
  console.log('WebSocket:', support.webSocket);
  console.log('SharedArrayBuffer:', support.sharedArrayBuffer);
  console.log('Backend (streaming) STT:', support.backendSupported);
  if (support.unsupportedReason) {
    console.warn('Unsupported Reason:', support.unsupportedReason);
  }
  console.groupEnd();
}
