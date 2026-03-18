/**
 * @arcaai/noise-filter - Browser Support Utilities Tests
 *
 * Tests for noise filter browser capability detection utilities.
 * Note: These tests run in jsdom environment which simulates a browser.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('noise-filter browserSupport utilities', () => {
  describe('isBrowser detection', () => {
    it('should return true in jsdom environment', async () => {
      const { isBrowser } = await import('../utils/browserSupport.js');
      expect(isBrowser()).toBe(true);
    });
  });

  describe('Safari detection regex', () => {
    it('should match Safari user agent pattern', () => {
      const safariPattern = /^((?!chrome|android).)*safari/i;

      expect(
        safariPattern.test(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15'
        )
      ).toBe(true);

      expect(
        safariPattern.test(
          'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        )
      ).toBe(false);
    });
  });

  describe('Safari version extraction', () => {
    it('should extract version from Safari user agent', () => {
      const versionPattern = /Version\/(\d+\.\d+)/;

      const match = 'Mozilla/5.0 Version/17.4 Safari/605.1.15'.match(versionPattern);
      expect(match?.[1]).toBe('17.4');
    });
  });

  describe('Safari AudioWorklet support threshold', () => {
    it('should correctly determine 17.4+ support', () => {
      const isSupported = (versionStr: string): boolean => {
        const [major, minor] = versionStr.split('.').map(Number);
        if (major === undefined) return false;
        return major > 17 || (major === 17 && (minor ?? 0) >= 4);
      };

      expect(isSupported('17.4')).toBe(true);
      expect(isSupported('18.0')).toBe(true);
      expect(isSupported('17.3')).toBe(false);
      expect(isSupported('16.0')).toBe(false);
    });
  });

  describe('NoiseFilterBrowserSupport interface', () => {
    it('should return correct shape from getNoiseFilterBrowserSupport', async () => {
      const { getNoiseFilterBrowserSupport } = await import('../utils/browserSupport.js');
      const support = getNoiseFilterBrowserSupport();

      expect(support).toHaveProperty('webAssembly');
      expect(support).toHaveProperty('audioWorklet');
      expect(support).toHaveProperty('sharedArrayBuffer');
      expect(support).toHaveProperty('rnnoiseSupported');
      expect(support).toHaveProperty('nativeFallbackAvailable');

      // In jsdom with mocked APIs, values depend on what's available
      expect(typeof support.webAssembly).toBe('boolean');
      expect(typeof support.audioWorklet).toBe('boolean');
      expect(typeof support.sharedArrayBuffer).toBe('boolean');
      expect(typeof support.rnnoiseSupported).toBe('boolean');
      expect(typeof support.nativeFallbackAvailable).toBe('boolean');
    });
  });

  describe('utility function behavior in jsdom', () => {
    it('should return appropriate values for browser-specific checks', async () => {
      const {
        isBrowser,
        isWebAssemblySupported,
        isAudioWorkletSupported,
        isSharedArrayBufferSupported,
        isAudioContextSupported,
        isMediaStreamTrackSupported,
        isScriptProcessorSupported,
        isNativeNoiseSuppressionSupported,
        isSafari,
        isRNNoiseSupported,
      } = await import('../utils/browserSupport.js');

      expect(isBrowser()).toBe(true);
      // These return boolean values based on jsdom + mocked capabilities
      expect(typeof isWebAssemblySupported()).toBe('boolean');
      expect(typeof isAudioWorkletSupported()).toBe('boolean');
      expect(typeof isSharedArrayBufferSupported()).toBe('boolean');
      expect(typeof isAudioContextSupported()).toBe('boolean');
      expect(typeof isMediaStreamTrackSupported()).toBe('boolean');
      expect(typeof isScriptProcessorSupported()).toBe('boolean');
      expect(typeof isNativeNoiseSuppressionSupported()).toBe('boolean');
      expect(isSafari()).toBe(false); // jsdom is not Safari
      expect(typeof isRNNoiseSupported()).toBe('boolean');
    });

    it('should return null for getSafariVersion when not Safari', async () => {
      const { getSafariVersion } = await import('../utils/browserSupport.js');
      expect(getSafariVersion()).toBeNull();
    });

    it('should return false for isSafariAudioWorkletSupported when not Safari', async () => {
      const { isSafariAudioWorkletSupported } = await import('../utils/browserSupport.js');
      expect(isSafariAudioWorkletSupported()).toBe(false);
    });

    it('should return a valid processing mode', async () => {
      const { getRecommendedProcessingMode } = await import('../utils/browserSupport.js');
      const mode = getRecommendedProcessingMode();
      expect(['quality', 'performance', 'balanced']).toContain(mode);
    });
  });

  describe('unsupportedReason', () => {
    it('should set reason only when features are missing', async () => {
      const { getNoiseFilterBrowserSupport } = await import('../utils/browserSupport.js');
      const support = getNoiseFilterBrowserSupport();

      // In jsdom with mocked AudioContext, the reason depends on available features
      if (!support.rnnoiseSupported && !support.nativeFallbackAvailable) {
        expect(support.unsupportedReason).toBeDefined();
      }
    });
  });
});
