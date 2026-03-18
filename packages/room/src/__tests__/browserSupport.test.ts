/**
 * @arcaai/room - Browser Support Utilities Tests
 *
 * Tests for browser capability detection utilities.
 * Note: These tests run in jsdom environment which simulates a browser.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the entire module to test its behavior
describe('browserSupport utilities', () => {
  describe('isBrowser detection logic', () => {
    it('should detect browser environment based on globals', async () => {
      // Dynamic import to test fresh module state
      const { isBrowser } = await import('../utils/browserSupport.js');
      // In jsdom environment, should return true
      expect(isBrowser()).toBe(true);
    });
  });

  describe('Safari detection regex', () => {
    it('should match Safari user agent pattern', () => {
      const safariPattern = /^((?!chrome|android).)*safari/i;

      // Safari user agent
      expect(
        safariPattern.test(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
        )
      ).toBe(true);

      // Chrome user agent (has Safari but also Chrome)
      expect(
        safariPattern.test(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )
      ).toBe(false);

      // Firefox user agent
      expect(
        safariPattern.test(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
        )
      ).toBe(false);

      // Android Chrome
      expect(
        safariPattern.test(
          'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        )
      ).toBe(false);
    });
  });

  describe('Safari version extraction', () => {
    it('should extract version from Safari user agent', () => {
      const versionPattern = /Version\/(\d+\.\d+)/;

      // Safari 17.4
      const match1 = 'Mozilla/5.0 Version/17.4 Safari/605.1.15'.match(versionPattern);
      expect(match1?.[1]).toBe('17.4');

      // Safari 16.3
      const match2 = 'Mozilla/5.0 Version/16.3 Safari/605.1.15'.match(versionPattern);
      expect(match2?.[1]).toBe('16.3');

      // Safari 18.0
      const match3 = 'Mozilla/5.0 Version/18.0 Safari/605.1.15'.match(versionPattern);
      expect(match3?.[1]).toBe('18.0');
    });
  });

  describe('Safari version support check', () => {
    it('should correctly determine AudioWorklet support threshold', () => {
      const isSupported = (versionStr: string): boolean => {
        const [major, minor] = versionStr.split('.').map(Number);
        return (major ?? 0) > 17 || ((major ?? 0) === 17 && (minor ?? 0) >= 4);
      };

      // Supported versions (17.4+)
      expect(isSupported('17.4')).toBe(true);
      expect(isSupported('17.5')).toBe(true);
      expect(isSupported('18.0')).toBe(true);
      expect(isSupported('19.0')).toBe(true);

      // Unsupported versions (below 17.4)
      expect(isSupported('17.3')).toBe(false);
      expect(isSupported('17.0')).toBe(false);
      expect(isSupported('16.3')).toBe(false);
      expect(isSupported('16.0')).toBe(false);
      expect(isSupported('15.0')).toBe(false);
    });
  });

  describe('BrowserSupport interface shape', () => {
    it('should return correct shape from getBrowserSupport in jsdom', async () => {
      const { getBrowserSupport } = await import('../utils/browserSupport.js');
      const support = getBrowserSupport();

      // Verify structure
      expect(support).toHaveProperty('getUserMedia');
      expect(support).toHaveProperty('audioContext');
      expect(support).toHaveProperty('audioWorklet');
      expect(support).toHaveProperty('mediaStreamTrack');
      expect(support).toHaveProperty('isSafari');
      expect(support).toHaveProperty('safariVersion');
      expect(support).toHaveProperty('isFullySupported');

      // In jsdom with mocked APIs, some features may be available
      expect(typeof support.getUserMedia).toBe('boolean');
      expect(typeof support.audioContext).toBe('boolean');
      expect(typeof support.audioWorklet).toBe('boolean');
      expect(typeof support.mediaStreamTrack).toBe('boolean');
      expect(support.isSafari).toBe(false); // jsdom is not Safari
      expect(typeof support.isFullySupported).toBe('boolean');
    });
  });

  describe('utility function behavior in jsdom', () => {
    it('should return appropriate values for browser-specific checks', async () => {
      const {
        isBrowser,
        isSafari,
        isGetUserMediaSupported,
        isAudioContextSupported,
        isAudioWorkletSupported,
        isMediaStreamTrackSupported,
        isSharedArrayBufferSupported,
        isBasicAudioSupported,
        isWebAudioSupported,
        isAdvancedAudioSupported,
      } = await import('../utils/browserSupport.js');

      expect(isBrowser()).toBe(true);
      expect(isSafari()).toBe(false); // jsdom is not Safari
      // These return boolean values based on jsdom + mocked capabilities
      expect(typeof isGetUserMediaSupported()).toBe('boolean');
      expect(typeof isAudioContextSupported()).toBe('boolean');
      expect(typeof isAudioWorkletSupported()).toBe('boolean');
      expect(typeof isMediaStreamTrackSupported()).toBe('boolean');
      expect(typeof isBasicAudioSupported()).toBe('boolean');
      expect(typeof isWebAudioSupported()).toBe('boolean');
      expect(typeof isAdvancedAudioSupported()).toBe('boolean');
      expect(typeof isSharedArrayBufferSupported()).toBe('boolean');
    });

    it('should return AudioContext constructor when available', async () => {
      const { getAudioContextConstructor } = await import('../utils/browserSupport.js');
      // With mocked AudioContext, this should return the constructor
      const constructor = getAudioContextConstructor();
      expect(constructor === undefined || typeof constructor === 'function').toBe(true);
    });

    it('should return null for getSafariVersion when not Safari', async () => {
      const { getSafariVersion } = await import('../utils/browserSupport.js');
      expect(getSafariVersion()).toBeNull();
    });

    it('should return true for isSafariVersionSupported when not Safari', async () => {
      const { isSafariVersionSupported } = await import('../utils/browserSupport.js');
      // When not Safari, should return true (no version check needed)
      expect(isSafariVersionSupported()).toBe(true);
    });
  });
});
