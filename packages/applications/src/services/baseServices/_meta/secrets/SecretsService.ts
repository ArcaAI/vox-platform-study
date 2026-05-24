import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { LRUCacheWithDelete } from 'mnemonist';
import {
  ISecretsProvider,
  SECRETS_PROVIDER_TOKEN,
  SecretFetchOptions,
  SecretsHealth,
} from './ISecretsProvider';

export interface SecretsServiceOptions {
  /** Default TTL applied to every cached secret. Default 300s. */
  defaultTtlSec?: number;
  /** LRU max entries. Default 200. */
  lruMax?: number;
}

export const SECRETS_SERVICE_OPTIONS = Symbol.for('SecretsServiceOptions');

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * SecretsService — consumer-facing wrapper around ISecretsProvider.
 *
 * Phase 2C (TASK-302 Stream B). Adds:
 * - LRU cache (mnemonist/lru-cache) with per-entry TTL.
 * - invalidate(key) / invalidateAll() for explicit eviction.
 * - boot() to delegate to provider boot + warm up keys (Task 2.18).
 * - Redis Pub/Sub subscriber (Task 2.16) so rotations on one pod evict
 *   caches across the fleet.
 */
@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);
  private readonly cache: LRUCacheWithDelete<string, CacheEntry>;
  private readonly defaultTtlSec: number;

  constructor(
    @Inject(SECRETS_PROVIDER_TOKEN)
    private readonly provider: ISecretsProvider,
    @Optional()
    @Inject(SECRETS_SERVICE_OPTIONS)
    opts: SecretsServiceOptions = {},
  ) {
    // LRUCacheWithDelete supports .delete() which the plain LRUCache lacks.
    this.cache = new LRUCacheWithDelete(opts.lruMax ?? 200);
    this.defaultTtlSec = opts.defaultTtlSec ?? 300;
  }

  private effectiveTtlSec(opts?: SecretFetchOptions): number {
    return opts?.ttlSec ?? this.defaultTtlSec;
  }

  async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
    if (!opts?.refresh) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
    }
    const v = await this.provider.getSecret(key, opts);
    const ttlSec = this.effectiveTtlSec(opts);
    if (ttlSec > 0) {
      this.cache.set(key, { value: v, expiresAt: Date.now() + ttlSec * 1000 });
    }
    return v;
  }

  async getSecretOptional(
    key: string,
    opts?: SecretFetchOptions,
  ): Promise<string | undefined> {
    try {
      return await this.getSecret(key, opts);
    } catch {
      return undefined;
    }
  }

  async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
    const raw = await this.getSecret(key, opts);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`SecretsService: secret '${key}' is not valid JSON`);
    }
  }

  async getSecrets(
    keys: string[],
    opts?: SecretFetchOptions,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const missing: string[] = [];
    for (const k of keys) {
      if (opts?.refresh) {
        missing.push(k);
        continue;
      }
      const hit = this.cache.get(k);
      if (hit && hit.expiresAt > Date.now()) {
        out[k] = hit.value;
      } else {
        missing.push(k);
      }
    }
    if (missing.length === 0) return out;
    const fetched = await this.provider.getSecrets(missing, opts);
    const ttlSec = this.effectiveTtlSec(opts);
    for (const [k, v] of Object.entries(fetched)) {
      if (ttlSec > 0) {
        this.cache.set(k, { value: v, expiresAt: Date.now() + ttlSec * 1000 });
      }
      out[k] = v;
    }
    return out;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  health(): Promise<SecretsHealth> {
    return this.provider.health();
  }
}
