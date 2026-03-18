/**
 * @arcaai/room - useBrowserCapabilities Hook Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBrowserCapabilities } from '../hooks/useBrowserCapabilities.js';

describe('useBrowserCapabilities', () => {
  it('should return capabilities object', () => {
    const { result } = renderHook(() => useBrowserCapabilities());
    expect(result.current.capabilities).toBeDefined();
    expect(result.current.capabilities.browserName).toBeDefined();
    expect(result.current.capabilities.browserVersion).toBeDefined();
    expect(typeof result.current.capabilities.isSupported).toBe('boolean');
  });

  it('should return limitations array', () => {
    const { result } = renderHook(() => useBrowserCapabilities());
    expect(Array.isArray(result.current.limitations)).toBe(true);
  });

  it('should return isSupported boolean', () => {
    const { result } = renderHook(() => useBrowserCapabilities());
    expect(typeof result.current.isSupported).toBe('boolean');
  });

  it('should return supportsMultipleMics boolean', () => {
    const { result } = renderHook(() => useBrowserCapabilities());
    expect(typeof result.current.supportsMultipleMics).toBe('boolean');
  });

  it('should memoize results across re-renders', () => {
    const { result, rerender } = renderHook(() => useBrowserCapabilities());
    const first = result.current.capabilities;
    rerender();
    expect(result.current.capabilities).toBe(first);
  });

  it('should provide checkFeature function', () => {
    const { result } = renderHook(() => useBrowserCapabilities());
    expect(typeof result.current.checkFeature).toBe('function');
    expect(result.current.checkFeature('nonexistent-feature')).toBe(false);
  });

  it('should checkFeature return boolean for known features', () => {
    const { result } = renderHook(() => useBrowserCapabilities());
    const knownFeatures = [
      'multiple-mics',
      'audio-worklet',
      'audio-worklet-reliable',
      'persistent-permissions',
      'background-audio',
      'shared-array-buffer',
      'wasm-simd',
    ];
    for (const feature of knownFeatures) {
      expect(typeof result.current.checkFeature(feature)).toBe('boolean');
    }
  });
});
