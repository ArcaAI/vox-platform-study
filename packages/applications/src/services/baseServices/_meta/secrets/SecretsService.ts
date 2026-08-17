import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { LRUCacheWithDelete } from 'mnemonist';
import { ISecretsProvider, SECRETS_PROVIDER_TOKEN, SecretFetchOptions, SecretsHealth, SecretsProviderName } from './ISecretsProvider';

export interface SecretsServiceOptions {
  /** Default TTL applied to every cached secret. Default 300s. */
  defaultTtlSec?: number;
  /** LRU max entries. Default 200. */
  lruMax?: number;
  /**
   * How often (seconds) to re-warm the `boot({ warmupKeys })` set so the
   * cache-only `getSecretSync` path never goes cold on TTL expiry. Unset / <= 0
   * derives a safe default of `max(30, floor(defaultTtlSec / 2))` — re-warming
   * at half the TTL guarantees a valid entry always outlives one failed cycle.
   */
  reWarmIntervalSec?: number;
}

export const SECRETS_SERVICE_OPTIONS = Symbol.for('SecretsServiceOptions');

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * SecretsService — consumer-facing wrapper around ISecretsProvider. Adds:
 * - LRU cache (mnemonist/lru-cache) with per-entry TTL.
 * - invalidate(key) / invalidateAll() for explicit eviction.
 * - boot() to delegate to provider boot + warm up keys.
 * - Redis Pub/Sub subscriber so rotations on one pod evict
 *   caches across the fleet.
 */
@Injectable()
export class SecretsService implements OnModuleDestroy {
  private readonly logger = new Logger(SecretsService.name);
  private readonly cache: LRUCacheWithDelete<string, CacheEntry>;
  private readonly defaultTtlSec: number;
  private readonly reWarmIntervalSecOpt: number;

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
    this.reWarmIntervalSecOpt = opts.reWarmIntervalSec ?? 0;
  }

  private effectiveTtlSec(opts?: SecretFetchOptions): number {
    return opts?.ttlSec ?? this.defaultTtlSec;
  }

  // ---------------------------------------------------------------------------
  // Cache identity — one entry per (key, kv-v2 version)
  // ---------------------------------------------------------------------------
  //
  // A pinned version and "latest" are DIFFERENT values under one name (that is
  // the whole point of staged rotation), so a version-blind cache
  // key would serve v3 to a caller that asked for v2. Unversioned reads keep the
  // bare key as their cache key, so nothing about the existing entries changes.

  /** Cache key for a read. */
  private cacheKey(key: string, opts?: SecretFetchOptions): string {
    return opts?.version === undefined ? key : `${key}#v${opts.version}`;
  }

  /** Cache keys currently held per secret NAME, so `invalidate(name)` drops them all. */
  private readonly cacheKeysByName = new Map<string, Set<string>>();

  private cacheSet(name: string, cacheKey: string, entry: CacheEntry): void {
    this.cache.set(cacheKey, entry);
    const keys = this.cacheKeysByName.get(name);
    if (keys) keys.add(cacheKey);
    else this.cacheKeysByName.set(name, new Set([cacheKey]));
  }

  // ---------------------------------------------------------------------------
  // Resolution source — "every fallback is observable"
  // ---------------------------------------------------------------------------
  //
  // `getSecret()` returns a string and, before this, nothing distinguished
  // "read from Vault kv-v2" from "read out of `process.env`". A deployment that
  // silently kept `SECRETS_PROVIDER=env` therefore looked — in every log line
  // and every health check — exactly like a correctly Vault-backed one, while
  // its platform credentials sat in the process environment.
  //
  // We record the supplying tier for every resolved key, and warn ONCE per key
  // when the `env` tier supplies a value in a non-development runtime. There is
  // deliberately NO cross-tier fallback: a `vault` provider that cannot resolve
  // a key throws (secrets are `failMode: 'closed'`). Silently
  // reading `process.env` behind a Vault miss would authenticate as whatever
  // happened to be in the environment, which is the failure this module exists
  // to make impossible. `SECRETS_PROVIDER=env` remains fully supported: it is
  // the dev and CI path, and it is the PROVIDER, not a fallback, there.

  private readonly resolutionSource = new Map<string, SecretsProviderName | 'unknown'>();
  private readonly warnedFallbackKeys = new Set<string>();

  /** The tier that supplied `key`'s current value, or undefined if never resolved. */
  getResolutionSource(key: string): SecretsProviderName | 'unknown' | undefined {
    return this.resolutionSource.get(key);
  }

  /**
   * True when this process is a deployed runtime rather than a developer's box
   * or a test runner. Only there is a value coming from the env tier a
   * *fallback* worth warning about.
   *
   * `NODE_ENV` alone, deliberately: adding a `VITEST` clause would make the
   * deployed branch unreachable from a test, and Vitest already pins
   * `NODE_ENV=test`, so the suite is silent without one.
   */
  private isDeployedRuntime(): boolean {
    const nodeEnv = process.env.NODE_ENV;
    return nodeEnv !== 'development' && nodeEnv !== 'test';
  }

  /** Attribute a freshly-fetched value to its tier and surface env fallbacks once. */
  private recordResolution(key: string): void {
    const source = this.provider.name ?? 'unknown';
    this.resolutionSource.set(key, source);
    if (source !== 'env' || !this.isDeployedRuntime() || this.warnedFallbackKeys.has(key)) return;
    this.warnedFallbackKeys.add(key);
    // Names the key and the tier only — never the value.
    this.logger.warn(
      `Secret '${key}' was supplied by the 'env' tier (process environment), not by a secrets backend. ` +
        `SECRETS_PROVIDER is unset or 'env' in NODE_ENV=${process.env.NODE_ENV}. Deployed environments should read platform ` +
        `credentials from Vault kv-v2 (SECRETS_PROVIDER=vault); seed them with scripts/vault-seed-secrets.sh.`,
    );
  }

  async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
    const cacheKey = this.cacheKey(key, opts);
    if (!opts?.refresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
    }
    const v = await this.provider.getSecret(key, opts);
    this.recordResolution(key);
    const ttlSec = this.effectiveTtlSec(opts);
    if (ttlSec > 0) {
      this.cacheSet(key, cacheKey, { value: v, expiresAt: Date.now() + ttlSec * 1000 });
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
      const hit = this.cache.get(this.cacheKey(k, opts));
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
      this.recordResolution(k);
      if (ttlSec > 0) {
        this.cacheSet(k, this.cacheKey(k, opts), { value: v, expiresAt: Date.now() + ttlSec * 1000 });
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
      this.warmupKeys = [...opts.warmupKeys];
      const results = await Promise.allSettled(opts.warmupKeys.map((k) => this.getSecret(k)));
      const failed = results.map((r, i) => (r.status === 'rejected' ? opts.warmupKeys![i] : null)).filter((k): k is string => k !== null);
      if (failed.length > 0) {
        this.logger.warn(`SecretsService.boot(): warmup miss for ${failed.length}/${opts.warmupKeys.length} key(s): ${failed.join(', ')}`);
      }
      // Keep the warmup set continuously warm. `getSecretSync` is cache-only and
      // its entries carry the per-secret TTL, so without a re-warm loop every
      // warmed key silently goes cold `defaultTtlSec` after boot — dropping the
      // `X-Service-Token` header on the sync-only proxy paths (SMR/TTS) and
      // turning healthy calls into upstream 401s minutes after startup. Refresh
      // is a NO-OP when caching is disabled (`defaultTtlSec <= 0`) or nothing
      // was warmed.
      this.startReWarm();
    }
  }

  // ---------------------------------------------------------------------------
  // Warmup re-warm loop — keeps `getSecretSync` consumers from going cold
  // ---------------------------------------------------------------------------
  //
  // The sync path (TextCompatController / TextProxyController / TtsWsGateway
  // `getForwardHeaders`) cannot await Vault, so it reads `getSecretSync`, which
  // returns `undefined` on any cache miss — including a plain TTL expiry. Boot
  // warms the keys once; this loop re-fetches them at half the TTL so a warmed
  // key is ALWAYS present. Using `{ refresh: true }` also makes the loop a
  // bounded-staleness backstop for rotations (the `arca:secrets:invalidate`
  // pub/sub channel remains the fast propagation path).

  private warmupKeys: readonly string[] = [];
  private reWarmTimer: ReturnType<typeof setInterval> | null = null;

  /** Effective re-warm cadence: explicit option/env, else half the TTL (floor 30s). */
  private reWarmIntervalMs(): number {
    if (this.reWarmIntervalSecOpt > 0) return this.reWarmIntervalSecOpt * 1000;
    return Math.max(30, Math.floor(this.defaultTtlSec / 2)) * 1000;
  }

  private startReWarm(): void {
    // Nothing to keep warm, or caching disabled (entries never expire off TTL
    // because they are never stored) → no loop.
    if (this.reWarmTimer || this.warmupKeys.length === 0 || this.defaultTtlSec <= 0) return;
    this.reWarmTimer = setInterval(() => {
      void this.reWarmWarmupKeys();
    }, this.reWarmIntervalMs());
    // Never let the loop hold the event loop open (clean shutdown, test exit).
    this.reWarmTimer.unref?.();
  }

  /**
   * Re-fetch every warmup key, resetting its TTL. A failed key is logged at WARN
   * and its EXISTING cached value is left in place — because the loop runs at
   * half the TTL, a single transient provider blip still leaves a valid entry
   * for the sync path, and the next cycle retries. Public for deterministic
   * testing (fake timers) and operational forced-refresh.
   */
  async reWarmWarmupKeys(): Promise<void> {
    if (this.warmupKeys.length === 0) return;
    const results = await Promise.allSettled(this.warmupKeys.map((k) => this.getSecret(k, { refresh: true })));
    const failed = this.warmupKeys.filter((_, i) => results[i]?.status === 'rejected');
    if (failed.length > 0) {
      // Names keys only, never values. Existing cache entries are
      // retained; the sync path keeps serving the last-good token until recovery.
      this.logger.warn(
        `SecretsService re-warm miss for ${failed.length}/${this.warmupKeys.length} key(s): ${failed.join(', ')} (last-good values retained)`,
      );
    }
  }

  /** Stop the re-warm loop. Idempotent. Called on module destroy. */
  stopReWarm(): void {
    if (this.reWarmTimer) {
      clearInterval(this.reWarmTimer);
      this.reWarmTimer = null;
    }
  }

  onModuleDestroy(): void {
    this.stopReWarm();
  }

  /**
   * Evict `key`. Drops EVERY cached kv-v2 version of it, not just the latest:
   * a rotation announcement must not leave a pinned version serving material
   * the operator believes is gone.
   */
  invalidate(key: string): void {
    this.cache.delete(key);
    const versioned = this.cacheKeysByName.get(key);
    if (versioned) {
      for (const cacheKey of versioned) this.cache.delete(cacheKey);
      this.cacheKeysByName.delete(key);
    }
    // A warmup key must not stay evicted between re-warm cycles: the sync path
    // would drop its `X-Service-Token` header until the next loop tick. Rotation
    // invalidation means the value CHANGED, so re-fetch it now (fire-and-forget,
    // `refresh` already implied by the eviction above) to re-populate the
    // cache-only path with the NEW value promptly.
    if (this.warmupKeys.includes(key)) {
      void this.getSecretOptional(key);
    }
  }

  invalidateAll(): void {
    this.cache.clear();
    this.cacheKeysByName.clear();
  }

  /**
   * Channel used by all cluster nodes to broadcast cache evictions when a
   * secret is rotated (the rotation worker publishes here).
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
   * Optional VaultLeaseRenewer handle. When
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
      // Preserve a provider-level degraded signal (e.g. the
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
   * Proxy to provider.encrypt() when
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
  /**
   * Capability predicate for the runtime Transit surface (encrypt/decrypt).
   * True iff the underlying provider implements `encrypt` — i.e.
   * `SECRETS_PROVIDER=vault`. Lets callers (e.g. secret encryption-at-rest
   * wiring) skip encryption gracefully on env/aws/azure/in-memory providers
   * instead of catching the fail-fast guard error. `decrypt`/`decryptBatch`
   * ship together with `encrypt` on the Vault provider, so one check covers
   * the whole Transit surface.
   */
  supportsTransit(): boolean {
    return typeof (this.provider as unknown as { encrypt?: unknown }).encrypt === 'function';
  }

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
   * Vault Transit BATCH decrypt. Decrypts many ciphertexts in
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
   * Resolved name of the dedicated PHI Transit key.
   * Clinical free-text fields encrypt under this key (separate from
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
   * Issue a short-lived DB
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

  /**
   * Renew a Vault DB-engine lease (extends its TTL up to
   * max_ttl without changing the underlying PG user). Called by
   * VaultLeaseRenewer ahead of lease expiry; falls back to a fresh
   * requestDbCredential()-backed pool swap once max_ttl is reached.
   * Capability-checked like requestDbCredential; throws fail-fast on
   * non-Vault providers.
   */
  async renewDbLease(leaseId: string, incrementSec: number): Promise<{ ttlSec: number }> {
    const maybe = this.provider as unknown as {
      renewDbLease?: (leaseId: string, incrementSec: number) => Promise<{ ttlSec: number }>;
    };
    if (typeof maybe.renewDbLease !== 'function') {
      throw new Error(
        'SecretsService.renewDbLease() requires Vault provider (SECRETS_PROVIDER=vault); current provider has no database-engine support',
      );
    }
    return maybe.renewDbLease(leaseId, incrementSec);
  }
}
