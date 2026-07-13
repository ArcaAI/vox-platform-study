/**
 * TASK-499 P2 — Redis-backed `CacheProvider` for `@node-saml/node-saml`.
 *
 * `SAML.getAuthorizeUrlAsync` saves the outstanding AuthnRequest id via
 * `cacheProvider.saveAsync`; `validatePostResponseAsync` (`InResponseTo`
 * validation) consults it via `getAsync`/`removeAsync`. The library's default
 * `InMemoryCacheProvider` is per-pod only — insufficient once `start` and
 * `acs` can land on different replicas (same class of problem
 * `IdpResolverService.resolveByProviderId`'s doc comment already flags for
 * the OIDC path). Swapping in this Redis-backed provider gives D4's
 * "InResponseTo matches a live AuthnRequest" + single-use replay defense for
 * free, using the library's own extension point rather than a bespoke
 * parallel cache.
 */

import type { CacheItem, CacheProvider } from '@node-saml/node-saml';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';

export class RedisSamlCacheProvider implements CacheProvider {
  constructor(
    private readonly cache: IRedisCacheService,
    private readonly keyPrefix: string,
    private readonly ttlSeconds: number,
  ) {}

  /** Matches `InMemoryCacheProvider`: does NOT overwrite an existing key — returns `null` on collision. */
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const redisKey = this.prefixed(key);
    if (await this.cache.exists(redisKey)) {
      return null;
    }
    const createdAt = Date.now();
    await this.cache.setex(redisKey, this.ttlSeconds, JSON.stringify({ value, createdAt }));
    return { value, createdAt };
  }

  async getAsync(key: string): Promise<string | null> {
    const raw = await this.cache.get(this.prefixed(key));
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as CacheItem;
      return parsed.value;
    } catch {
      return null;
    }
  }

  /** Single-use: deletes the key and returns it, or `null` if it was already gone (replay). */
  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) {
      return null;
    }
    const redisKey = this.prefixed(key);
    if (!(await this.cache.exists(redisKey))) {
      return null;
    }
    await this.cache.del(redisKey);
    return key;
  }

  private prefixed(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}
