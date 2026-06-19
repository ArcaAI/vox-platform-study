import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { LRUCacheWithDelete } from 'mnemonist';
import { ISecretsProvider, SECRETS_PROVIDER_TOKEN, SecretFetchOptions, SecretsHealth } from './ISecretsProvider';

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

  async getSecretOptional(key: string, opts?: SecretFetchOptions): Promise<string | undefined> {
    try {
      return await this.getSecret(key, opts);
    } catch {
      return undefined;
    }
  }

  /**
   * Synchronous, cache-only lookup. Used by sync call sites that cannot
   * await — passport strategies' verify callback, http-proxy-middleware's
   * on.proxyReq hook, etc. The expectation is the caller arranged for the
   * key to be pre-warmed via SecretsService.boot({ warmupKeys: [...] }).
   *
   * Returns `undefined` on a miss (TTL expired, never warmed, or unknown
   * key). Callers must tolerate undefined without throwing — typically by
   * either failing the request or omitting the optional header. This is
   * a deliberate non-fallback: we do NOT lazy-load from the provider here
   * because that would re-introduce blocking I/O into a sync hot path.
   */
  getSecretSync(key: string): string | undefined {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    return undefined;
  }

  async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
    const raw = await this.getSecret(key, opts);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`SecretsService: secret '${key}' is not valid JSON`);
    }
  }

  async getSecrets(keys: string[], opts?: SecretFetchOptions): Promise<Record<string, string>> {
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

  /**
   * Boot hook: delegate to provider.boot() if the provider implements
   * one (VaultSecretsProvider does; Env/InMemory/AWS/Azure do not), then
   * warm up the cache for the listed keys so the first request after
   * app.listen() does not pay a Vault round-trip.
   *
   * Missing warmup keys are tolerated (logged at WARN) so a single
   * misconfigured key doesn't block boot.
   */
  async boot(opts: { warmupKeys?: string[] } = {}): Promise<void> {
    const providerBoot = (this.provider as unknown as { boot?: () => Promise<void> }).boot;
    if (typeof providerBoot === 'function') {
      await providerBoot.call(this.provider);
    }
    if (opts.warmupKeys && opts.warmupKeys.length > 0) {
      const results = await Promise.allSettled(opts.warmupKeys.map((k) => this.getSecret(k)));
      const failed = results.map((r, i) => (r.status === 'rejected' ? opts.warmupKeys![i] : null)).filter((k): k is string => k !== null);
      if (failed.length > 0) {
        this.logger.warn(`SecretsService.boot(): warmup miss for ${failed.length}/${opts.warmupKeys.length} key(s): ${failed.join(', ')}`);
      }
    }
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Channel used by all cluster nodes to broadcast cache evictions when a
   * secret is rotated (Phase 6 rotation worker publishes here).
   *
   * Payloads:
   *   { key: '<KEY>' }   - evict one key
   *   { all: true }      - evict all keys
   */
  static readonly INVALIDATION_CHANNEL = 'arca:secrets:invalidate';

  /**
   * Attach an ioredis subscriber (or shaped-compatible client) so this
   * SecretsService participates in cluster-wide cache eviction. Typed as
   * a structural minimum so unit tests do not need to spin up Redis.
   */
  attachRedisSubscriber(sub: {
    subscribe: (channel: string, cb: (err: Error | null, count: number) => void) => void;
    on: (event: 'message', handler: (channel: string, raw: string) => void) => void;
  }): void {
    sub.subscribe(SecretsService.INVALIDATION_CHANNEL, (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to ${SecretsService.INVALIDATION_CHANNEL}: ${err.message}`);
      }
    });
    sub.on('message', (channel: string, raw: string) => {
      if (channel !== SecretsService.INVALIDATION_CHANNEL) return;
      let msg: { key?: string; all?: boolean } | undefined;
      try {
        msg = JSON.parse(raw) as { key?: string; all?: boolean };
      } catch {
        this.logger.warn(`Bad ${SecretsService.INVALIDATION_CHANNEL} payload (ignored): ${raw.slice(0, 64)}`);
        return;
      }
      if (msg?.all) {
        this.invalidateAll();
      } else if (msg?.key) {
        this.invalidate(msg.key);
      }
    });
  }

  /**
   * Optional VaultLeaseRenewer handle (Phase 5 Task 5.7). When
   * present, `health()` reports its `.degraded` flag so health
   * indicators can warn without flipping `ok=false`. We intentionally
   * type structurally so this file does not depend on
   * `vault-lease-renewer.ts` at type-resolution time, keeping the
   * import graph one-directional.
   */
  private leaseRenewer: { readonly degraded: boolean; readonly failureCount: number } | null = null;

  setLeaseRenewer(renewer: { readonly degraded: boolean; readonly failureCount: number }): void {
    this.leaseRenewer = renewer;
  }

  clearLeaseRenewer(): void {
    this.leaseRenewer = null;
  }

  async health(): Promise<SecretsHealth> {
    const base = await this.provider.health();
    if (!this.leaseRenewer || !this.leaseRenewer.degraded) {
      // TASK-312 B.4: preserve a provider-level degraded signal (e.g. the
      // Vault AppRole token-renew loop crossing its failure threshold) rather
      // than hard-coding false, which previously swallowed it.
      return { ...base, degraded: base.degraded === true };
    }
    const merged: SecretsHealth = {
      ...base,
      degraded: true,
      detail: base.detail
        ? `${base.detail}; lease-renew degraded (failures=${this.leaseRenewer.failureCount})`
        : `lease-renew degraded (failures=${this.leaseRenewer.failureCount})`,
    };
    return merged;
  }

  /**
   * Phase 4 Task 4.5 (TASK-302 Stream B) — proxy to provider.encrypt() when
   * the underlying provider implements Vault Transit. We deliberately do
   * NOT widen ISecretsProvider with encrypt/decrypt because the cloud
   * provider stubs (Env/InMemory/AWS/Azure) and the Vault provider have
   * different secrets-engine surfaces, and the type union would force
   * every consumer to handle "unsupported by this provider" everywhere.
   *
   * Instead we keep encrypt/decrypt as a *capability check* at runtime:
   *   - SECRETS_PROVIDER=vault → provider.encrypt exists → delegates.
   *   - SECRETS_PROVIDER=env|aws|azure|in-memory → throws fail-fast.
   *
   * The error message intentionally does NOT include the plaintext or
   * the ciphertext, so a misconfigured prod node that hits this guard
   * cannot accidentally surface either material in a log line.
   */
  async encrypt(plaintext: Buffer, keyName?: string): Promise<string> {
    const maybe = this.provider as unknown as {
      encrypt?: (b: Buffer, k?: string) => Promise<string>;
    };
    if (typeof maybe.encrypt !== 'function') {
      throw new Error('SecretsService.encrypt() requires Vault provider (SECRETS_PROVIDER=vault); current provider has no transit support');
    }
    return maybe.encrypt(plaintext, keyName);
  }

  async decrypt(ciphertext: string, keyName?: string): Promise<Buffer> {
    const maybe = this.provider as unknown as {
      decrypt?: (s: string, k?: string) => Promise<Buffer>;
    };
    if (typeof maybe.decrypt !== 'function') {
      throw new Error('SecretsService.decrypt() requires Vault provider (SECRETS_PROVIDER=vault); current provider has no transit support');
    }
    return maybe.decrypt(ciphertext, keyName);
  }

  /**
   * TASK-369 Phase 6 — Vault Transit BATCH decrypt. Decrypts many ciphertexts in
   * ONE round-trip, preserving input order. Powers repository decrypt-on-read
   * for multi-row/list reads. Capability-checked like encrypt/decrypt: requires
   * the Vault provider; throws fail-fast otherwise (the error omits material).
   */
  async decryptBatch(ciphertexts: string[], keyName?: string): Promise<Buffer[]> {
    const maybe = this.provider as unknown as {
      decryptBatch?: (cts: string[], k?: string) => Promise<Buffer[]>;
    };
    if (typeof maybe.decryptBatch !== 'function') {
      throw new Error('SecretsService.decryptBatch() requires Vault provider (SECRETS_PROVIDER=vault); current provider has no transit support');
    }
    return maybe.decryptBatch(ciphertexts, keyName);
  }

  /**
   * Resolved name of the dedicated PHI Transit key. Data Encryption Initiative
   * Phase 3A — clinical free-text fields encrypt under this key (separate from
   * the secrets `transitKey`). When the underlying provider exposes
   * `phiTransitKey` (Vault) that value wins so `VAULT_TRANSIT_KEY_PHI` ops
   * overrides take effect; otherwise we default to 'hope-phi' so the field
   * encryption helpers work even with no env configured / non-Vault provider.
   */
  getPhiTransitKeyName(): string {
    const maybe = this.provider as unknown as { phiTransitKey?: string };
    return maybe.phiTransitKey ?? 'hope-phi';
  }

  /**
   * Phase 5 Task 5.3 (TASK-302 Stream B) — issue a short-lived DB
   * credential from Vault's database secrets engine. Returns the
   * triple `{ username, password, leaseId, ttlSec }`; the caller (the
   * `@prisma/adapter-pg` password callback in `getPrismaClientWithVault`)
   * uses the password on the very next connection and discards the
   * triple. The credential is intentionally NOT cached here:
   *
   *   1. Caching would defeat the per-connection rotation pattern.
   *   2. The renewer (Task 5.7) owns the lease lifecycle separately.
   *   3. We must not persist DB credentials in process memory longer
   *      than the connection that needs them (Gate 5 requirement).
   *
   * Capability check at runtime; throws fail-fast if the underlying
   * provider does not implement issueDbCredential (env, in-memory,
   * AWS Secrets Manager, Azure Key Vault all lack this). The error
   * message deliberately omits the requested role name so a
   * misconfigured pod doesn't surface the role into a log line.
   */
  async requestDbCredential(role: string): Promise<{
    username: string;
    password: string;
    leaseId: string;
    ttlSec: number;
  }> {
    const maybe = this.provider as unknown as {
      issueDbCredential?: (r: string) => Promise<{
        username: string;
        password: string;
        leaseId: string;
        ttlSec: number;
      }>;
    };
    if (typeof maybe.issueDbCredential !== 'function') {
      throw new Error(
        'SecretsService.requestDbCredential() requires Vault provider (SECRETS_PROVIDER=vault); current provider has no database-engine support',
      );
    }
    return maybe.issueDbCredential(role);
  }
}
