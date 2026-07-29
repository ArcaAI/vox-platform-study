/**
 * @arcaai/vad - Browser Support Utilities Tests
 *
 * Tests for VAD browser capability detection utilities.
 * Note: These tests run in jsdom environment which simulates a browser.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('vad browserSupport utilities', () => {
  describe('isBrowser detection', () => {
    it('should return true in jsdom environment', async () => {
      const { isBrowser } = await import('../utils/browserSupport.js');
      // In jsdom, window, navigator, and document are defined
      expect(isBrowser()).toBe(true);
    });
  });

  describe('Safari detection regex', () => {
    it('should match Safari user agent pattern', () => {
      const safariPattern = /^((?!chrome|android).)*safari/i;

      expect(safariPattern.test('Mozilla/5.0 Version/17.4 Safari/605.1.15')).toBe(true);

      expect(safariPattern.test('Chrome/120.0.0.0 Safari/537.36')).toBe(false);
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

  describe('iOS detection regex', () => {
    it('should detect iOS devices', () => {
      const iosPattern = /iPad|iPhone|iPod/;

      expect(iosPattern.test('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
      expect(iosPattern.test('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe(true);
      expect(iosPattern.test('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0)')).toBe(true);
      expect(iosPattern.test('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe(false);
    });
  });

  describe('VADBrowserSupport interface', () => {
    it('should return correct shape from getVADBrowserSupport', async () => {
      const { getVADBrowserSupport } = await import('../utils/browserSupport.js');
      const support = getVADBrowserSupport();

      expect(support).toHaveProperty('webAssembly');
      expect(support).toHaveProperty('audioWorklet');
      expect(support).toHaveProperty('sharedArrayBuffer');
      expect(support).toHaveProperty('onnxRuntime');
      expect(support).toHaveProperty('vadSupported');
      expect(support).toHaveProperty('recommendedModel');

      // In jsdom, WebAssembly is supported, but AudioWorklet may not be
      expect(typeof support.webAssembly).toBe('boolean');
      expect(typeof support.audioWorklet).toBe('boolean');
      expect(typeof support.sharedArrayBuffer).toBe('boolean');
      expect(typeof support.vadSupported).toBe('boolean');
    });
  });

  describe('utility function behavior in jsdom', () => {
    it('should return appropriate values for browser checks in jsdom', async () => {
      const {
        isBrowser,
        isWebAssemblySupported,
        isAudioWorkletSupported,
        isSharedArrayBufferSupported,
        isCrossOriginIsolated,
        isAudioContextSupported,
        isMediaStreamTrackSupported,
        isScriptProcessorSupported,
        isGetUserMediaSupported,
        isSafari,
        isIOS,
        isONNXRuntimeSupported,
        isVADSupported,
        isMultiThreadedONNXSupported,
      } = await import('../utils/browserSupport.js');

      // In jsdom, isBrowser returns true
      expect(isBrowser()).toBe(true);
      // These return boolean values based on jsdom capabilities
      expect(typeof isWebAssemblySupported()).toBe('boolean');
      expect(typeof isAudioWorkletSupported()).toBe('boolean');
      expect(typeof isSharedArrayBufferSupported()).toBe('boolean');
      expect(typeof isCrossOriginIsolated()).toBe('boolean');
      expect(typeof isAudioContextSupported()).toBe('boolean');
      expect(typeof isMediaStreamTrackSupported()).toBe('boolean');
      expect(typeof isScriptProcessorSupported()).toBe('boolean');
      expect(typeof isGetUserMediaSupported()).toBe('boolean');
      // Safari/iOS detection based on user agent - returns false in jsdom (not Safari)
      expect(isSafari()).toBe(false);
      expect(isIOS()).toBe(false);
      expect(typeof isONNXRuntimeSupported()).toBe('boolean');
      expect(typeof isVADSupported()).toBe('boolean');
      expect(typeof isMultiThreadedONNXSupported()).toBe('boolean');
    });

    it('should return null for getSafariVersion when not Safari', async () => {
      const { getSafariVersion } = await import('../utils/browserSupport.js');
      expect(getSafariVersion()).toBeNull();
    });

    it('should return false for isSafariAudioWorkletSupported when not Safari', async () => {
      const { isSafariAudioWorkletSupported } = await import('../utils/browserSupport.js');
      expect(isSafariAudioWorkletSupported()).toBe(false);
    });
  });

  describe('getFrameSamplesForModel', () => {
    it('should return 512 for v5 model', async () => {
      const { getFrameSamplesForModel } = await import('../utils/browserSupport.js');
      expect(getFrameSamplesForModel('v5')).toBe(512);
    });

    it('should return 1536 for legacy model', async () => {
      const { getFrameSamplesForModel } = await import('../utils/browserSupport.js');
      expect(getFrameSamplesForModel('legacy')).toBe(1536);
    });
  });

  describe('getRecommendedModel', () => {
    it('should return v5 in jsdom environment (not Safari/iOS)', async () => {
      const { getRecommendedModel } = await import('../utils/browserSupport.js');
      // In jsdom, not Safari and not iOS, so v5 is recommended
      expect(getRecommendedModel()).toBe('v5');
    });
  });

  describe('unsupportedReason', () => {
    it('should set appropriate reason based on missing features', async () => {
      const { getVADBrowserSupport } = await import('../utils/browserSupport.js');
      const support = getVADBrowserSupport();

      // In jsdom, the unsupported reason depends on what features are missing
      // It could be undefined if supported, or a string explaining the limitation
      if (!support.vadSupported) {
        expect(typeof support.unsupportedReason).toBe('string');
      }
    });
  });
});
