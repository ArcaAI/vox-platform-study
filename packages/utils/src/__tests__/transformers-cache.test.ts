/**
 * @arcaai/utils - Transformers.js tenant-scoped cache tests
 *
 * Custom (`source: 'custom'`) model weights must be cached under a
 * TENANT-scoped Cache Storage name so one tenant's
 * private model artifacts can never be read/served from another tenant's
 * session. Public (HF-hub) weights stay on the shared, unchanged cache, and a
 * tenant's custom cache is cleaned up (orphan removal) on tenant switch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getTransformersCacheName,
  clearTenantCustomTransformersCache,
  SHARED_TRANSFORMERS_CACHE_NAME,
} from '../transformers-cache';

// ----------------------------------------------------------------------------
// Minimal in-memory Cache Storage mock (utils vitest runs in the `node` env, so
// `caches` / `window` are not present and must be stubbed).
// ----------------------------------------------------------------------------

class MockCache {
  private store = new Map<string, unknown>();

  async put(request: string | { url: string }, response: unknown): Promise<void> {
    const url = typeof request === 'string' ? request : request.url;
    this.store.set(url, response);
  }

  async match(request: string | { url: string }): Promise<unknown | undefined> {
    const url = typeof request === 'string' ? request : request.url;
    return this.store.get(url);
  }

  async keys(): Promise<Array<{ url: string }>> {
    return [...this.store.keys()].map((url) => ({ url }));
  }
}

class MockCacheStorage {
  private caches = new Map<string, MockCache>();

  async open(name: string): Promise<MockCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MockCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

let mockCaches: MockCacheStorage;

beforeEach(() => {
  mockCaches = new MockCacheStorage();
  vi.stubGlobal('caches', mockCaches);
  vi.stubGlobal('window', { caches: mockCaches });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tenant-scoped custom Transformers.js cache', () => {
  it('caches custom (source:"custom") weights for tenant A and B under distinct names', () => {
    const nameA = getTransformersCacheName({ source: 'custom', tenantId: 'tenant-a' });
    const nameB = getTransformersCacheName({ source: 'custom', tenantId: 'tenant-b' });

    expect(nameA).toBe('vox/tenant-a/transformers');
    expect(nameB).toBe('vox/tenant-b/transformers');
    expect(nameA).not.toBe(nameB);
  });

  it('leaves PUBLIC (HF-hub) weights on the shared, unchanged cache name', () => {
    expect(getTransformersCacheName({ source: 'public' })).toBe(SHARED_TRANSFORMERS_CACHE_NAME);
    expect(getTransformersCacheName({})).toBe(SHARED_TRANSFORMERS_CACHE_NAME);
    expect(getTransformersCacheName()).toBe(SHARED_TRANSFORMERS_CACHE_NAME);
    // The shared name must match the value Transformers.js already uses today.
    expect(SHARED_TRANSFORMERS_CACHE_NAME).toBe('transformers-cache');
  });

  it('fails closed when a custom model is requested without a usable tenantId', () => {
    expect(() => getTransformersCacheName({ source: 'custom' })).toThrow();
    expect(() => getTransformersCacheName({ source: 'custom', tenantId: '   ' })).toThrow();
  });

  it("isolates one tenant's custom weights from another tenant's cache", async () => {
    const cacheA = await caches.open(getTransformersCacheName({ source: 'custom', tenantId: 'tenant-a' }));
    await cacheA.put('https://tenant-a.example/custom-asr/model.onnx', {} as Response);

    const cacheB = await caches.open(getTransformersCacheName({ source: 'custom', tenantId: 'tenant-b' }));
    const aKeys = await cacheA.keys();
    const bKeys = await cacheB.keys();

    expect(aKeys.map((r) => r.url)).toContain('https://tenant-a.example/custom-asr/model.onnx');
    expect(bKeys).toHaveLength(0);
  });

  it("orphan cleanup removes ONLY the outgoing tenant's custom cache", async () => {
    await caches.open(getTransformersCacheName({ source: 'custom', tenantId: 'tenant-a' }));
    await caches.open(getTransformersCacheName({ source: 'custom', tenantId: 'tenant-b' }));
    await caches.open(SHARED_TRANSFORMERS_CACHE_NAME);

    const removed = await clearTenantCustomTransformersCache('tenant-a');
    expect(removed).toBe(true);

    const remaining = await caches.keys();
    expect(remaining).not.toContain('vox/tenant-a/transformers');
    // Sibling tenant + shared public cache are untouched.
    expect(remaining).toContain('vox/tenant-b/transformers');
    expect(remaining).toContain(SHARED_TRANSFORMERS_CACHE_NAME);
  });

  it('orphan cleanup never touches the shared public cache and is a no-op for a blank tenantId', async () => {
    await caches.open(SHARED_TRANSFORMERS_CACHE_NAME);

    expect(await clearTenantCustomTransformersCache('')).toBe(false);
    expect(await clearTenantCustomTransformersCache('   ')).toBe(false);

    const remaining = await caches.keys();
    expect(remaining).toContain(SHARED_TRANSFORMERS_CACHE_NAME);
  });
});
