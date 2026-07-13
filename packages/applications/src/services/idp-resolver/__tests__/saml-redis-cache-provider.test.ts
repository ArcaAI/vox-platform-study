/**
 * TASK-499 P2 — `RedisSamlCacheProvider` unit tests.
 *
 * `@node-saml/node-saml`'s `SAML` class already tracks outstanding AuthnRequest
 * ids via a pluggable `CacheProvider` (default: in-memory, single-pod only) and
 * consults it during `validateInResponseTo` — this IS the "InResponseTo
 * matches a live AuthnRequest" + single-use replay defense the ticket's D4
 * calls for, so we swap in a Redis-backed provider rather than hand-rolling a
 * parallel request-tracking cache.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisSamlCacheProvider } from '../saml-redis-cache-provider';

function makeCache() {
  const store = new Map<string, string>();
  return {
    exists: vi.fn(async (key: string) => store.has(key)),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    __store: store,
  };
}

describe('RedisSamlCacheProvider', () => {
  let cache: ReturnType<typeof makeCache>;
  let provider: RedisSamlCacheProvider;

  beforeEach(() => {
    cache = makeCache();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider = new RedisSamlCacheProvider(cache as any, 'saml-authn-request:', 300);
  });

  it('saves a new key with the prefix and TTL, returning a CacheItem', async () => {
    const item = await provider.saveAsync('req-1', 'issued-at-value');

    expect(item).not.toBeNull();
    expect(item!.value).toBe('issued-at-value');
    expect(typeof item!.createdAt).toBe('number');
    expect(cache.setex).toHaveBeenCalledWith('saml-authn-request:req-1', 300, expect.any(String));
  });

  it('refuses to overwrite an existing key (matches node-saml in-memory semantics)', async () => {
    await provider.saveAsync('req-1', 'first');
    const second = await provider.saveAsync('req-1', 'second');

    expect(second).toBeNull();
  });

  it('round-trips a saved value through getAsync', async () => {
    await provider.saveAsync('req-1', 'issued-at-value');
    const value = await provider.getAsync('req-1');

    expect(value).toBe('issued-at-value');
  });

  it('getAsync returns null for a key that was never saved', async () => {
    const value = await provider.getAsync('missing');
    expect(value).toBeNull();
  });

  it('removeAsync deletes an existing key and returns it (single-use)', async () => {
    await provider.saveAsync('req-1', 'issued-at-value');
    const removed = await provider.removeAsync('req-1');

    expect(removed).toBe('req-1');
    expect(await provider.getAsync('req-1')).toBeNull();
  });

  it('removeAsync returns null for a key that does not exist', async () => {
    expect(await provider.removeAsync('missing')).toBeNull();
  });

  it('removeAsync returns null when given a null key', async () => {
    expect(await provider.removeAsync(null)).toBeNull();
  });

  it('a removed request cannot be replayed — a second removeAsync sees nothing', async () => {
    await provider.saveAsync('req-1', 'issued-at-value');
    await provider.removeAsync('req-1');
    const replay = await provider.removeAsync('req-1');

    expect(replay).toBeNull();
  });
});
