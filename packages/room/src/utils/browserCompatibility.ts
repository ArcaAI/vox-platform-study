/**
 * @arcaai/room - Browser Compatibility Utilities
 *
 * Detailed browser detection and capability assessment for audio processing.
 * Enforces minimum browser versions and detects feature support.
 */

import type { BrowserCapabilities, BrowserLimitation, BrowserName } from '../types/index.js';
import { isBrowser, isSharedArrayBufferSupported, isAudioWorkletSupported } from './browserSupport.js';

const MIN_VERSIONS: Record<Exclude<BrowserName, 'unknown'>, number> = {
  chrome: 91,
  edge: 91,
  firefox: 120,
  safari: 16.4,
  'ios-safari': 16.4,
};

/**
 * Detect the browser name from the user agent string.
 */
export function detectBrowserName(ua?: string): BrowserName {
  if (!isBrowser() && !ua) return 'unknown';
  const userAgent = ua ?? navigator.userAgent;

  if (/iP(hone|od|ad)/.test(userAgent) && /AppleWebKit/.test(userAgent) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(userAgent)) {
    return 'ios-safari';
  }
  if (/Edg\//.test(userAgent)) return 'edge';
  if (/Firefox\//.test(userAgent) && !/Seamonkey\//.test(userAgent)) return 'firefox';
  if (/Chrome\//.test(userAgent) && !/Chromium\//.test(userAgent)) return 'chrome';
  if (/^((?!chrome|android).)*safari/i.test(userAgent)) return 'safari';

  return 'unknown';
}

/**
 * Extract the browser version number from the user agent string.
 */
export function detectBrowserVersion(browserName: BrowserName, ua?: string): string {
  if (!isBrowser() && !ua) return '0';
  const userAgent = ua ?? navigator.userAgent;

  const patterns: Record<string, RegExp> = {
    chrome: /Chrome\/(\d+(?:\.\d+)?)/,
    edge: /Edg\/(\d+(?:\.\d+)?)/,
    firefox: /Firefox\/(\d+(?:\.\d+)?)/,
    safari: /Version\/(\d+(?:\.\d+)?)/,
    'ios-safari': /Version\/(\d+(?:\.\d+)?)/,
  };

  const pattern = patterns[browserName];
  if (!pattern) return '0';

  const match = userAgent.match(pattern);
  return match?.[1] ?? '0';
}

/**
 * Check if the browser version meets the minimum requirement.
 */
export function meetsMinimumVersion(browserName: BrowserName, version: string): boolean {
  if (browserName === 'unknown') return false;
  const minVersion = MIN_VERSIONS[browserName];
  const currentVersion = parseFloat(version);
  return currentVersion >= minVersion;
}

/**
 * Detect if WASM SIMD is supported.
 */
export function detectWasmSimd(): boolean {
  if (!isBrowser()) return false;
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
    );
  } catch {
    return false;
  }
}

/**
 * Get comprehensive browser capabilities for audio processing.
 */
export function getBrowserCapabilities(ua?: string): BrowserCapabilities {
  const browserName = detectBrowserName(ua);
  const browserVersion = detectBrowserVersion(browserName, ua);
  const isSupported = meetsMinimumVersion(browserName, browserVersion);

  const isIosSafari = browserName === 'ios-safari';
  const isSafariAny = browserName === 'safari' || isIosSafari;
  const isFirefox = browserName === 'firefox';

  const versionNum = parseFloat(browserVersion);

  return {
    browserName,
    browserVersion,
    isSupported,
    supportsMultipleMics: !isFirefox && isSupported,
    supportsAudioWorklet: isAudioWorkletSupported(),
    audioWorkletReliable: !(isIosSafari && versionNum >= 17.0 && versionNum < 19.0),
    supportsPersistentPermissions: !isSafariAny,
    supportsBackgroundAudio: !isIosSafari,
    supportsSharedArrayBuffer: isSharedArrayBufferSupported(),
    supportsWasmSimd: detectWasmSimd(),
    requiresUserGesture: true,
    recommendedSampleRate: isSafariAny ? 48000 : 48000,
  };
}

/**
 * Get a list of browser limitations for the current environment.
 */
export function getBrowserLimitations(capabilities?: BrowserCapabilities): BrowserLimitation[] {
  const caps = capabilities ?? getBrowserCapabilities();
  const limitations: BrowserLimitation[] = [];

  if (!caps.isSupported) {
    limitations.push({
      feature: 'browser-version',
      severity: 'blocker',
      description: `${caps.browserName} ${caps.browserVersion} is not supported. Minimum versions: Chrome 91+, Edge 91+, Firefox 120+, Safari 16.4+.`,
      workaround: 'Please update your browser to the latest version.',
    });
  }

  if (!caps.supportsMultipleMics) {
    limitations.push({
      feature: 'multiple-microphones',
      severity: 'degraded',
      description: 'Firefox cannot capture from multiple microphones simultaneously.',
      workaround: 'Use single microphone mode. Switch between devices by stopping and restarting capture.',
    });
  }

  if (!caps.audioWorkletReliable) {
    limitations.push({
      feature: 'audio-worklet',
      severity: 'degraded',
      description: 'AudioWorklet has known playback bugs on iOS Safari 17-18.',
      workaround: 'Audio processing may experience intermittent issues. Consider using a desktop browser for best results.',
    });
  }

  if (!caps.supportsPersistentPermissions) {
    limitations.push({
      feature: 'persistent-permissions',
      severity: 'info',
      description: 'Safari only grants microphone permission for the current session.',
      workaround: 'You will be prompted for microphone access each time you visit.',
    });
  }

  if (!caps.supportsBackgroundAudio) {
    limitations.push({
      feature: 'background-audio',
      severity: 'degraded',
      description: 'Audio processing stops when the app is in the background on iOS.',
      workaround: 'Keep the browser tab active and the screen on during audio capture.',
    });
  }

  if (!caps.supportsSharedArrayBuffer) {
    limitations.push({
      feature: 'shared-array-buffer',
      severity: 'info',
      description: 'SharedArrayBuffer is not available. Multi-threaded WASM processing will be slower.',
      workaround: 'Ensure the server sends Cross-Origin-Embedder-Policy and Cross-Origin-Opener-Policy headers.',
    });
  }

  return limitations;
}
