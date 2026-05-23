/**
 * @arcaai/med-ner - WebGPU Detection Tests (H-1)
 *
 * Covers `isWebGPUSupported` and `getRecommendedDevice`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { isWebGPUSupported, getRecommendedDevice } from '../utils/browserSupport.js';

type NavWithGPU = Navigator & {
  gpu?: { requestAdapter: () => Promise<unknown> };
};

describe('isWebGPUSupported', () => {
  let originalGpu: unknown;

  beforeEach(() => {
    originalGpu = (navigator as NavWithGPU).gpu;
  });

  afterEach(() => {
    if (originalGpu === undefined) {
      delete (navigator as NavWithGPU).gpu;
    } else {
      (navigator as NavWithGPU).gpu = originalGpu as NavWithGPU['gpu'];
    }
  });

  it('should return false when navigator.gpu is undefined', () => {
    delete (navigator as NavWithGPU).gpu;
    expect(isWebGPUSupported()).toBe(false);
  });

  it('should return true when navigator.gpu is defined', () => {
    (navigator as NavWithGPU).gpu = { requestAdapter: vi.fn() };
    expect(isWebGPUSupported()).toBe(true);
  });
});

describe('getRecommendedDevice', () => {
  let originalGpu: unknown;

  beforeEach(() => {
    originalGpu = (navigator as NavWithGPU).gpu;
  });

  afterEach(() => {
    if (originalGpu === undefined) {
      delete (navigator as NavWithGPU).gpu;
    } else {
      (navigator as NavWithGPU).gpu = originalGpu as NavWithGPU['gpu'];
    }
  });

  it('returns "wasm" when navigator.gpu is missing', async () => {
    delete (navigator as NavWithGPU).gpu;
    await expect(getRecommendedDevice()).resolves.toBe('wasm');
  });

  it('returns "webgpu" when requestAdapter resolves to an adapter', async () => {
    (navigator as NavWithGPU).gpu = {
      requestAdapter: vi.fn().mockResolvedValue({ name: 'mock-adapter' }),
    };
    await expect(getRecommendedDevice()).resolves.toBe('webgpu');
  });

  it('returns "wasm" when requestAdapter resolves to null', async () => {
    (navigator as NavWithGPU).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(null),
    };
    await expect(getRecommendedDevice()).resolves.toBe('wasm');
  });

  it('returns "wasm" when requestAdapter throws', async () => {
    (navigator as NavWithGPU).gpu = {
      requestAdapter: vi.fn().mockRejectedValue(new Error('blocked by policy')),
    };
    await expect(getRecommendedDevice()).resolves.toBe('wasm');
  });
});
