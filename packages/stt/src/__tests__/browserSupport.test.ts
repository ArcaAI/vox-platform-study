/**
 * @arcaai/stt - Browser Support Utilities Tests
 *
 * Tests for STT browser capability detection utilities.
 * Note: These tests run in jsdom environment which simulates a browser.
 *
 * TASK-1006 — the local (in-browser Whisper) capability checks (WebGPU,
 * Transformers.js, compute-device/provider recommendation) were removed
 * alongside the local provider: the browser never runs a model (TASK-865).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('stt browserSupport utilities', () => {
  describe('isBrowser detection', () => {
    it('should return true in jsdom environment', async () => {
      const { isBrowser } = await import('../utils/browserSupport.js');
      // In jsdom, window and document are defined
      expect(isBrowser()).toBe(true);
    });
  });

  describe('Safari detection regex', () => {
    it('should match Safari user agent pattern', () => {
      const safariPattern = /^((?!chrome|android).)*safari/i;

      expect(safariPattern.test('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15')).toBe(true);

      expect(safariPattern.test('Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36')).toBe(false);
    });
  });

  describe('Safari version support threshold', () => {
    it('should correctly determine 17.4+ support', () => {
      const isSupported = (version: number): boolean => {
        return version >= 17.4;
      };

      expect(isSupported(17.4)).toBe(true);
      expect(isSupported(18.0)).toBe(true);
      expect(isSupported(17.3)).toBe(false);
      expect(isSupported(16.0)).toBe(false);
    });
  });

  describe('STTBrowserSupport interface', () => {
    it('should return correct shape from getSTTBrowserSupport', async () => {
      const { getSTTBrowserSupport } = await import('../utils/browserSupport.js');
      const support = getSTTBrowserSupport();

      // Verify the interface shape — remote/backend-streaming only (TASK-1006).
      expect(support).toHaveProperty('audioWorklet');
      expect(support).toHaveProperty('webSocket');
      expect(support).toHaveProperty('sharedArrayBuffer');
      expect(support).toHaveProperty('backendSupported');
      expect(support).not.toHaveProperty('webGPU');
      expect(support).not.toHaveProperty('transformersJsSupported');
      expect(support).not.toHaveProperty('recommendedDevice');
      expect(support).not.toHaveProperty('recommendedProvider');
      expect(support).not.toHaveProperty('localSupported');

      expect(typeof support.audioWorklet).toBe('boolean');
      expect(typeof support.backendSupported).toBe('boolean');
    });
  });

  describe('utility function behavior in jsdom', () => {
    it('should return appropriate values for browser-specific checks in jsdom', async () => {
      const {
        isBrowser,
        isAudioWorkletSupported,
        isWebSocketSupported,
        isSharedArrayBufferSupported,
        isAudioContextSupported,
        isMediaStreamTrackSupported,
        isSafari,
        isSTTSupported,
      } = await import('../utils/browserSupport.js');

      // In jsdom, isBrowser returns true
      expect(isBrowser()).toBe(true);

      // These checks return boolean values based on jsdom capabilities
      expect(typeof isAudioWorkletSupported()).toBe('boolean');
      expect(typeof isWebSocketSupported()).toBe('boolean');
      expect(typeof isSharedArrayBufferSupported()).toBe('boolean');
      expect(typeof isAudioContextSupported()).toBe('boolean');
      expect(typeof isMediaStreamTrackSupported()).toBe('boolean');
      expect(typeof isSafari()).toBe('boolean');
      expect(typeof isSTTSupported()).toBe('boolean');
    });

    it('should return null for getSafariVersion when not Safari', async () => {
      const { getSafariVersion } = await import('../utils/browserSupport.js');
      expect(getSafariVersion()).toBeNull();
    });

    it('should return true for isSafariVersionSupported when not Safari', async () => {
      const { isSafariVersionSupported } = await import('../utils/browserSupport.js');
      expect(isSafariVersionSupported()).toBe(true);
    });
  });

  describe('unsupportedReason', () => {
    it('should set reason only when backend STT is unsupported', async () => {
      const { getSTTBrowserSupport } = await import('../utils/browserSupport.js');
      const support = getSTTBrowserSupport();

      if (!support.backendSupported) {
        expect(support.unsupportedReason).toBeDefined();
      } else {
        expect(support.unsupportedReason).toBeUndefined();
      }
    });
  });
});
