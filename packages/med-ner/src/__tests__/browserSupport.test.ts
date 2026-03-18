/**
 * @arcaai/med-ner - Browser Support Tests
 *
 * Note: These tests run in jsdom environment which simulates a browser.
 * isBrowser() returns true in jsdom since window/document are defined.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isBrowser,
  isWebAssemblySupported,
  isIndexedDBSupported,
  isFetchSupported,
  isSafari,
  getSafariVersion,
  isIOS,
  getDeviceMemory,
  getHardwareConcurrency,
  getRecommendedDtype,
  isMedNERSupported,
  getMedNERBrowserSupport,
} from '../utils/browserSupport.js';

describe('Browser Support Utilities', () => {
  describe('isBrowser', () => {
    it('should return true in jsdom environment', () => {
      // In jsdom, window and document are defined
      expect(isBrowser()).toBe(true);
    });
  });

  describe('isWebAssemblySupported', () => {
    it('should detect WebAssembly support', () => {
      // jsdom may or may not have WebAssembly
      const result = isWebAssemblySupported();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isIndexedDBSupported', () => {
    it('should detect IndexedDB support', () => {
      const result = isIndexedDBSupported();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isFetchSupported', () => {
    it('should return true when fetch is available', () => {
      expect(isFetchSupported()).toBe(true);
    });
  });

  describe('isSafari', () => {
    it('should return false in jsdom (not Safari user agent)', () => {
      // isSafari returns false in jsdom since user agent is not Safari
      expect(isSafari()).toBe(false);
    });
  });

  describe('getSafariVersion', () => {
    it('should return undefined for non-Safari', () => {
      expect(getSafariVersion()).toBeUndefined();
    });
  });

  describe('isIOS', () => {
    it('should return false in jsdom (not iOS)', () => {
      expect(isIOS()).toBe(false);
    });
  });

  describe('getDeviceMemory', () => {
    it('should return undefined if deviceMemory not available', () => {
      // deviceMemory is not available in jsdom
      const result = getDeviceMemory();
      expect(result === undefined || typeof result === 'number').toBe(true);
    });
  });

  describe('getHardwareConcurrency', () => {
    it('should return a positive number', () => {
      const result = getHardwareConcurrency();
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('getRecommendedDtype', () => {
    it('should return a valid dtype', () => {
      const result = getRecommendedDtype();
      expect(['fp32', 'fp16', 'q8', 'q4']).toContain(result);
    });
  });

  describe('isMedNERSupported', () => {
    it('should return a boolean', () => {
      const result = isMedNERSupported();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getMedNERBrowserSupport', () => {
    it('should return comprehensive support info', () => {
      const support = getMedNERBrowserSupport();

      expect(support).toHaveProperty('webAssembly');
      expect(support).toHaveProperty('indexedDB');
      expect(support).toHaveProperty('fetch');
      expect(support).toHaveProperty('nerSupported');
      expect(support).toHaveProperty('recommendedDtype');

      expect(typeof support.webAssembly).toBe('boolean');
      expect(typeof support.indexedDB).toBe('boolean');
      expect(typeof support.fetch).toBe('boolean');
      expect(typeof support.nerSupported).toBe('boolean');
      expect(['fp32', 'fp16', 'q8', 'q4']).toContain(support.recommendedDtype);
    });

    it('should set nerSupported based on webAssembly and fetch', () => {
      const support = getMedNERBrowserSupport();
      expect(support.nerSupported).toBe(support.webAssembly && support.fetch);
    });

    it('should provide unsupportedReason when not supported', () => {
      const support = getMedNERBrowserSupport();
      if (!support.nerSupported) {
        expect(support.unsupportedReason).toBeDefined();
        expect(typeof support.unsupportedReason).toBe('string');
      }
    });
  });
});
