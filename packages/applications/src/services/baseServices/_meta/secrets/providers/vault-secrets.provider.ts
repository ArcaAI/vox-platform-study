import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import vault from 'node-vault';
import { ISecretsProvider, SecretFetchOptions, SecretsHealth } from '../ISecretsProvider';

/**
 * Internal client shape used by VaultSecretsProvider. node-vault ships a
 * loose `Promise<any>` typed surface and is missing `unwrap` entirely;
 * declaring our own minimal contract keeps the provider strictly typed
 * without TS module-augmentation gymnastics over `export = NodeVault`.
 *
 * Methods are populated at runtime by node-vault from src/commands.js;
 * the runtime surface matches these signatures.
 */
interface VaultClientLike {
  token: string;
  read(path: string, requestOptions?: Record<string, unknown>): Promise<unknown>;
  write(path: string, data: unknown, requestOptions?: Record<string, unknown>): Promise<unknown>;
  approleLogin(options: { role_id: string; secret_id: string }): Promise<{
    auth: { client_token: string; lease_duration: number; renewable: boolean };
  }>;
  tokenRenewSelf(options?: { increment?: number | string }): Promise<{
    auth: { lease_duration: number; renewable: boolean };
  }>;
  unwrap(options?: { token?: string }): Promise<{
    data: Record<string, unknown>;
    request_id?: string;
    lease_id?: string;
  }>;
  health(options?: { standbyok?: boolean }): Promise<unknown>;
}

/**
 * VaultSecretsProvider configuration (TASK-302 Stream B).
 *
 * - `wrappedSecretId` is the canonical production path: a one-shot
 *   response-wrapped token unwrapped during `boot()`. The plaintext
 *   secret_id never touches disk.
 * - `secretId` is the raw secret_id; only used for local dev / fallback.
 *   Construction fails if neither is provided.
 */
export interface VaultProviderConfig {
  addr: string;
  roleId: string;
  /** Wrapped secret_id; unwrapped once during boot(). */
  wrappedSecretId?: string;
  /** Raw secret_id; dev/opt-in only. */
  secretId?: string;
  namespace?: string;
  /** kv-v2 mount name (default 'secret'). */
  kvMount: string;
  /** Prefix beneath the mount. Final path: <kvMount>/data/<kvPrefix>/<KEY>. */
  kvPrefix: string;
  /** Transit mount name (default 'transit'). */
  transitMount: string;
  /** Transit key name (default 'hope-globalsetting'). */
  transitKey: string;
  /**
   * Dedicated PHI Transit key name (default 'hope-phi'). Data Encryption
   * Initiative Phase 3A: clinical free-text is encrypted under a SEPARATE key
   * from `transitKey` so rotation cadence and Transit policy blast radius are
   * independent from the secrets key. Optional so existing call sites and the
   * provider-construction tests keep their two-arg transit defaults; resolved
   * to 'hope-phi' by the `phiTransitKey` getter when unset.
   */
  transitKeyPhi?: string;
  requestTimeoutMs?: number;
}

/**
 * VaultSecretsProvider — ISecretsProvider implementation backed by
 * HashiCorp Vault's kv-v2 secrets engine.
 *
 * Phase 2B (TASK-302 Stream B). Boot flow:
 *   1. Construct client against VAULT_ADDR (no auth yet).
 *   2. boot(): optionally unwrap wrapped secret_id, then AppRole login,
 *      store the client_token on the client. After boot() the provider
 *      is ready to serve reads.
 *
 * Reads follow the kv-v2 contract: each secret is stored at
 *   <kvMount>/data/<kvPrefix>/<KEY>
 * with payload `{ data: { value: '<secret>' } }`. The `value` field
 * is read by all consumers; multi-field payloads can be modelled by
 * upgrading to getSecretJson().
 */
@Injectable()
export class VaultSecretsProvider implements ISecretsProvider, OnModuleDestroy {
  private readonly logger = new Logger(VaultSecretsProvider.name);
  private client: VaultClientLike;
  private booted = false;

  // TASK-312 Phase B (B.1–B.4) — AppRole token self-renewal state. The pre-B
  // build captured lease_duration/renewable from the login but never renewed,
  // so a prod pod's token expired at token_max_ttl and every read then 403'd.
  private tokenRenewTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRenewable = false;
  private lastTokenTtlSec = 0;
  private tokenRenewFailures = 0;
  private tokenRenewDegraded = false;
  private readonly tokenRenewFailureThreshold = 3;

  constructor(private readonly config: VaultProviderConfig) {
    if (!config.addr) throw new Error('VaultSecretsProvider: VAULT_ADDR is required');
    if (!config.roleId) throw new Error('VaultSecretsProvider: VAULT_ROLE_ID is required');
    if (!config.wrappedSecretId && !config.secretId) {
      throw new Error('VaultSecretsProvider: either VAULT_WRAPPED_SECRET_ID or VAULT_SECRET_ID is required (secret_id missing)');
    }
    this.client = vault({
      apiVersion: 'v1',
      endpoint: config.addr,
      namespace: config.namespace,
      requestOptions: { timeout: config.requestTimeoutMs ?? 5000 },
    }) as unknown as VaultClientLike;
  }

  // ---------- boot ----------
  async boot(): Promise<void> {
    try {
      await this.doBoot();
    } catch (err: unknown) {
      // Fail closed (Phase B B.7/B.8): one clear, secret-free FATAL line so a
      // sealed/unreachable Vault aborts startup (k8s recycles the pod) instead
      // of surfacing a raw node-vault stack/body.
      throw this.bootFailure(err);
    }
  }

  /**
   * Map any boot failure to a single FATAL-shaped, secret-free Error. The
   * wrapped/raw secret_id and the session token are NEVER included. A sealed
   * Vault (HTTP 501/503) is named explicitly; other failures carry the
   * underlying message, which node-vault populates from the Vault *response
   * body* (e.g. "permission denied") — never the request payload, so no
   * secret material leaks.
   */
  private bootFailure(err: unknown): Error {
    const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    const sealedish = status === 503 || status === 501;
    const reason = sealedish ? `Vault is sealed or unavailable (HTTP ${status})` : ((err as Error)?.message ?? String(err));
    return new Error(
      `VaultSecretsProvider.boot() FATAL: cannot authenticate to Vault (${this.config.addr}) — ${reason}. Refusing to start without a Vault session.`,
    );
  }

  private async doBoot(): Promise<void> {
    let secretId = this.config.secretId;
    if (this.config.wrappedSecretId) {
      // Vault's /sys/wrapping/unwrap requires the caller to be authenticated
      // AS the wrap token (the wrap token doubles as a one-shot auth). We
      // swap the wrap token in as the client's auth, call unwrap with no
      // body (passing the same token in body decrements use-count twice
      // and Vault rejects the second lookup), then clear it. The AppRole
      // login below establishes the real session token.
      const previousToken = this.client.token;
      this.client.token = this.config.wrappedSecretId;
      try {
        const unwrapped = await this.client.unwrap();
        secretId = (unwrapped?.data as { secret_id?: string })?.secret_id;
      } finally {
        this.client.token = previousToken;
      }
    }
    if (!secretId) {
      throw new Error('VaultSecretsProvider.boot(): no secret_id available after unwrap');
    }
    const login = await this.client.approleLogin({
      role_id: this.config.roleId,
      secret_id: secretId,
    });
    this.client.token = login.auth.client_token;
    this.booted = true;
    this.logger.log(`Vault AppRole login successful (lease_duration=${login.auth.lease_duration}s, renewable=${login.auth.renewable})`);
    this.scheduleTokenRenewal(login.auth.lease_duration, login.auth.renewable);
  }

  // ---------- AppRole token renewal (Phase B B.1–B.4) ----------
  /**
   * Start the token self-renewal loop, mirroring VaultLeaseRenewer: renew at
   * 50% of the latest TTL, reschedule against the freshly-returned TTL, and on
   * failure keep retrying against the last-known TTL. Non-renewable or zero-TTL
   * tokens (root/dev) have nothing to renew, so we no-op — which also keeps the
   * provider-construction unit tests timer-free.
   */
  private scheduleTokenRenewal(ttlSec: number, renewable: boolean): void {
    if (!renewable || !ttlSec || ttlSec <= 0) return;
    this.tokenRenewable = true;
    this.lastTokenTtlSec = ttlSec;
    this.armTokenRenewTimer(ttlSec);
  }

  private armTokenRenewTimer(ttlSec: number): void {
    if (this.tokenRenewTimer) clearTimeout(this.tokenRenewTimer);
    const intervalMs = Math.max(1, Math.floor((ttlSec * 1000) / 2));
    this.tokenRenewTimer = setTimeout(() => void this.renewTokenTick(), intervalMs);
    // Never keep the event loop alive solely for renewal: prod is held open by
    // the HTTP server; short-lived CLI/test processes should still exit cleanly.
    this.tokenRenewTimer.unref?.();
  }

  /**
   * One renewal cycle. Observable side-effects are limited to the three health
   * bits (lastTokenTtlSec, tokenRenewFailures, tokenRenewDegraded). After
   * `tokenRenewFailureThreshold` consecutive failures `tokenRenewDegraded`
   * latches true so health() can warn (stale-while-revalidate) while k8s
   * liveness/readiness recycles the pod — which re-boots with a fresh AppRole
   * login. The first success resets the run and clears degraded.
   */
  private async renewTokenTick(): Promise<void> {
    if (!this.booted || !this.tokenRenewable) return;
    try {
      const res = await this.client.tokenRenewSelf();
      const newTtl = res?.auth?.lease_duration;
      const wasDegraded = this.tokenRenewDegraded;
      this.tokenRenewFailures = 0;
      this.tokenRenewDegraded = false;
      if (newTtl && newTtl > 0) this.lastTokenTtlSec = newTtl;
      if (wasDegraded) {
        this.logger.log(`Vault token renewal recovered (lease_duration=${this.lastTokenTtlSec}s)`);
      }
    } catch (err: unknown) {
      this.tokenRenewFailures += 1;
      this.logger.warn(`Vault token renewal failed (attempt=${this.tokenRenewFailures}): ${(err as Error).message}`);
      if (this.tokenRenewFailures >= this.tokenRenewFailureThreshold && !this.tokenRenewDegraded) {
        this.tokenRenewDegraded = true;
        this.logger.error(
          `Vault token renewal DEGRADED after ${this.tokenRenewFailures} consecutive failures; secrets-health reports degraded until renewal succeeds or the pod is recycled.`,
        );
      }
    } finally {
      // Keep renewing while booted; on failure reuse the last-known TTL so
      // attempts cluster close enough to recover before the token expires.
      if (this.booted && this.tokenRenewable) {
        this.armTokenRenewTimer(this.lastTokenTtlSec);
      }
    }
  }

  /** Cancel the renewal loop on app shutdown. Idempotent. */
  async onModuleDestroy(): Promise<void> {
    this.tokenRenewable = false;
    if (this.tokenRenewTimer) {
      clearTimeout(this.tokenRenewTimer);
      this.tokenRenewTimer = null;
    }
  }

  private ensureBooted(): void {
    if (!this.booted) {
      throw new Error('VaultSecretsProvider not booted; call boot() before reads');
    }
  }

  private kvPath(key: string): string {
    return `${this.config.kvMount}/data/${this.config.kvPrefix}/${key}`;
  }

  // ---------- transient-error retry (Phase B B.5/B.6) ----------
  /** Total attempts (1 initial + retries) for a transient Vault read. */
  private static readonly RETRY_MAX_ATTEMPTS = 3;

  /**
   * A transient failure is a Vault 5xx OR a transport error with no HTTP
   * status (ECONNREFUSED / ETIMEDOUT / socket hang up). 4xx is NOT transient:
   * 403/404/400 are authz / not-found / malformed and must surface immediately
   * so a misconfigured pod fails fast instead of hammering Vault on a backoff.
   */
  private isTransient(err: unknown): boolean {
    const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    if (typeof status === 'number') return status >= 500 && status <= 599;
    return true;
  }

  /**
   * Exponential backoff per retry. With RETRY_MAX_ATTEMPTS=3 only attempts 0 and
   * 1 actually sleep (250ms, then 500ms); the 3rd attempt is the last and
   * rethrows without sleeping. The formula extends (1000ms, …) if the cap rises.
   */
  private backoffMs(attempt: number): number {
    return 250 * 2 ** attempt;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Run a Vault read with bounded exponential-backoff retries on transient
   * errors. Wraps only the network call; the caller's 404/empty-value handling
   * runs against the final outcome. This closes the "100ms Vault blip → 5xx to
   * the user" gap (plan §2.2 #7) without masking auth errors.
   */
  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < VaultSecretsProvider.RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await op();
      } catch (err: unknown) {
        lastErr = err;
        const isLast = attempt === VaultSecretsProvider.RETRY_MAX_ATTEMPTS - 1;
        if (!this.isTransient(err) || isLast) throw err;
        this.logger.warn(
          `Vault read transient error (attempt=${attempt + 1}/${VaultSecretsProvider.RETRY_MAX_ATTEMPTS}); retrying in ${this.backoffMs(attempt)}ms`,
        );
        await this.delay(this.backoffMs(attempt));
      }
    }
    throw lastErr;
  }

  // ---------- reads ----------
  async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
    this.ensureBooted();
    const path = this.kvPath(key);
    try {
      const res = (await this.withRetry(() => this.client.read(path))) as { data?: { data?: { value?: string } } } | undefined;
      const value = res?.data?.data?.value;
      if (value === undefined || value === '') {
        if (opts?.required === false) return '';
        throw new Error(`VaultSecretsProvider: empty value at ${path}`);
      }
      return value;
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
      if (status === 404) {
        if (opts?.required === false) return '';
        throw new Error(`VaultSecretsProvider: required secret '${key}' not found`);
      }
      throw err;
    }
  }

  async getSecretOptional(key: string): Promise<string | undefined> {
    this.ensureBooted();
    const path = this.kvPath(key);
    try {
      const res = (await this.withRetry(() => this.client.read(path))) as { data?: { data?: { value?: string } } } | undefined;
      const value = res?.data?.data?.value;
      return value === '' ? undefined : value;
    } catch (err: unknown) {
      const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
      if (status === 404) return undefined;
      throw err;
    }
  }

  async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
    const raw = await this.getSecret(key, opts);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`VaultSecretsProvider: secret '${key}' is not valid JSON`);
    }
  }

  async getSecrets(keys: string[], opts?: SecretFetchOptions): Promise<Record<string, string>> {
    this.ensureBooted();
    const entries = await Promise.all(
      keys.map(async (k) => {
        try {
          return [k, await this.getSecret(k, opts)] as const;
        } catch {
          return [k, undefined] as const;
        }
      }),
    );
    const out: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  async rotateSecret(_key: string): Promise<void> {
    throw new Error(
      'VaultSecretsProvider.rotateSecret: not supported. Use kv-v2 versioning (vault kv put) plus the Phase 6 rotation worker to push new versions and invalidate caches.',
    );
  }

  async health(): Promise<SecretsHealth> {
    const t0 = Date.now();
    try {
      const h = (await this.client.health({ standbyok: true })) as {
        initialized: boolean;
        sealed: boolean;
      };
      const ok = !!h?.initialized && !h?.sealed;
      const baseDetail = ok ? 'active' : `initialized=${h?.initialized} sealed=${h?.sealed}`;
      return {
        ok,
        latencyMs: Date.now() - t0,
        provider: 'vault',
        degraded: this.tokenRenewDegraded,
        detail: this.tokenRenewDegraded ? `${baseDetail}; token-renew degraded (failures=${this.tokenRenewFailures})` : baseDetail,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        provider: 'vault',
        degraded: this.tokenRenewDegraded,
        detail: (err as Error).message,
      };
    }
  }

  // ---------- transit (Phase 4 helpers) ----------
  /**
   * Resolved PHI Transit key name. Defaults to 'hope-phi' so PHI encryption
   * works even when `VAULT_TRANSIT_KEY_PHI` is unset (Phase 3A requirement).
   */
  get phiTransitKey(): string {
    return this.config.transitKeyPhi ?? 'hope-phi';
  }

  /**
   * Encrypt via Vault Transit. `keyName` is OPTIONAL: when omitted the call
   * uses `this.config.transitKey` (kept for backward compatibility with the
   * GlobalSetting secrets path). PHI call sites pass the dedicated PHI key
   * (see `phiTransitKey`). Vault Transit ciphertext (`vault:vN:<b64>`) does
   * NOT embed the key name, so decrypt MUST pass the same key name.
   */
  async encrypt(plaintext: Buffer, keyName?: string): Promise<string> {
    this.ensureBooted();
    const key = keyName ?? this.config.transitKey;
    const path = `${this.config.transitMount}/encrypt/${key}`;
    const res = await this.client.write(path, {
      plaintext: plaintext.toString('base64'),
    });
    const ct = (res as { data?: { ciphertext?: string } })?.data?.ciphertext;
    if (!ct) throw new Error('VaultSecretsProvider.encrypt: empty ciphertext from transit');
    return ct;
  }

  async decrypt(ciphertext: string, keyName?: string): Promise<Buffer> {
    this.ensureBooted();
    const key = keyName ?? this.config.transitKey;
    const path = `${this.config.transitMount}/decrypt/${key}`;
    const res = await this.client.write(path, { ciphertext });
    const pt = (res as { data?: { plaintext?: string } })?.data?.plaintext;
    if (!pt) throw new Error('VaultSecretsProvider.decrypt: empty plaintext from transit');
    return Buffer.from(pt, 'base64');
  }

  // ---------- DB Secrets Engine (Phase 5 helper, available now for tests) ----------
  async issueDbCredential(role: string): Promise<{
    username: string;
    password: string;
    leaseId: string;
    ttlSec: number;
  }> {
    this.ensureBooted();
    const res = (await this.client.read(`database/creds/${role}`)) as {
      lease_id: string;
      lease_duration: number;
      data: { username: string; password: string };
    };
    const data = res?.data;
    if (!data?.username || !data?.password) {
      throw new Error('VaultSecretsProvider.issueDbCredential: empty creds');
    }
    return {
      username: data.username,
      password: data.password,
      leaseId: res.lease_id,
      ttlSec: res.lease_duration,
    };
  }
}
