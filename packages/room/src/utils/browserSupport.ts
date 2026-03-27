/**
 * @arcaai/room - Browser Support Utilities
 *
 * Utilities for detecting browser capabilities and compatibility.
 */

import type { BrowserSupport } from '../types/index.js';

/**
 * Check if the current environment is a browser.
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined';
}

/**
 * Detect if the current browser is Safari.
 */
export function isSafari(): boolean {
  if (!isBrowser()) return false;

  const ua = navigator.userAgent;
  return /^((?!chrome|android).)*safari/i.test(ua);
}

/**
 * Get Safari version if running in Safari.
 */
export function getSafariVersion(): string | null {
  if (!isSafari()) return null;

  const ua = navigator.userAgent;
  const match = ua.match(/Version\/(\d+\.\d+)/);
  return match?.[1] ?? null;
}

/**
 * Check if Safari version meets minimum requirements for AudioWorklet.
 * AudioWorklet is fully supported in Safari 17.4+
 */
export function isSafariVersionSupported(): boolean {
  const version = getSafariVersion();
  if (!version) return true; // Not Safari

  const [major, minor] = version.split('.').map(Number);
  // Safari 17.4+ has full AudioWorklet support
  return (major ?? 0) > 17 || ((major ?? 0) === 17 && (minor ?? 0) >= 4);
}

/**
 * Check if getUserMedia is supported.
 */
export function isGetUserMediaSupported(): boolean {
  if (!isBrowser()) return false;

  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
}

/**
 * Check if AudioContext is supported.
 */
export function isAudioContextSupported(): boolean {
  if (!isBrowser()) return false;

  return !!(window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
}

/**
 * Check if AudioWorklet is supported.
 */
export function isAudioWorkletSupported(): boolean {
  if (!isBrowser()) return false;

  return !!(isAudioContextSupported() && window.AudioWorkletNode !== undefined);
}

/**
 * Check if MediaStreamTrack is supported.
 */
export function isMediaStreamTrackSupported(): boolean {
  if (!isBrowser()) return false;

  return typeof MediaStreamTrack !== 'undefined';
}

/**
 * Check if SharedArrayBuffer is available (required for some advanced processing).
 */
export function isSharedArrayBufferSupported(): boolean {
  if (!isBrowser()) return false;

  try {
    return typeof SharedArrayBuffer !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Get comprehensive browser support information.
 */
export function getBrowserSupport(): BrowserSupport {
  const safari = isSafari();
  const safariVersion = getSafariVersion();

  const support: BrowserSupport = {
    getUserMedia: isGetUserMediaSupported(),
    audioContext: isAudioContextSupported(),
    audioWorklet: isAudioWorkletSupported(),
    mediaStreamTrack: isMediaStreamTrackSupported(),
    isSafari: safari,
    safariVersion,
    isFullySupported: false,
  };

  // Check if all required features are supported
  support.isFullySupported = support.getUserMedia && support.audioContext && support.mediaStreamTrack && (!safari || isSafariVersionSupported());

  return support;
}

/**
 * Check if all required features for basic audio capture are supported.
 */
export function isBasicAudioSupported(): boolean {
  return isGetUserMediaSupported() && isMediaStreamTrackSupported();
}

/**
 * Check if Web Audio API processing is supported.
 */
export function isWebAudioSupported(): boolean {
  return isAudioContextSupported();
}

/**
 * Check if advanced audio processing (AudioWorklet) is supported.
 */
export function isAdvancedAudioSupported(): boolean {
  return isAudioWorkletSupported() && (!isSafari() || isSafariVersionSupported());
}

/**
 * Get the AudioContext constructor with webkit fallback.
 */
export function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (!isBrowser()) return undefined;

  return window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}
