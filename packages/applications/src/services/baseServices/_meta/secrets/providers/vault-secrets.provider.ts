import { Injectable, Logger } from '@nestjs/common';
import vault from 'node-vault';
import {
  ISecretsProvider,
  SecretFetchOptions,
  SecretsHealth,
} from '../ISecretsProvider';

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
  write(
    path: string,
    data: unknown,
    requestOptions?: Record<string, unknown>,
  ): Promise<unknown>;
  approleLogin(options: { role_id: string; secret_id: string }): Promise<{
    auth: { client_token: string; lease_duration: number; renewable: boolean };
  }>;
  unwrap(options: { token: string }): Promise<{
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
export class VaultSecretsProvider implements ISecretsProvider {
  private readonly logger = new Logger(VaultSecretsProvider.name);
  private client: VaultClientLike;
  private booted = false;

  constructor(private readonly config: VaultProviderConfig) {
    if (!config.addr) throw new Error('VaultSecretsProvider: VAULT_ADDR is required');
    if (!config.roleId) throw new Error('VaultSecretsProvider: VAULT_ROLE_ID is required');
    if (!config.wrappedSecretId && !config.secretId) {
      throw new Error(
        'VaultSecretsProvider: either VAULT_WRAPPED_SECRET_ID or VAULT_SECRET_ID is required (secret_id missing)',
      );
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
    let secretId = this.config.secretId;
    if (this.config.wrappedSecretId) {
      const unwrapped = await this.client.unwrap({ token: this.config.wrappedSecretId });
      secretId = (unwrapped?.data as { secret_id?: string })?.secret_id;
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
    this.logger.log(
      `Vault AppRole login successful (lease_duration=${login.auth.lease_duration}s, renewable=${login.auth.renewable})`,
    );
  }

  private ensureBooted(): void {
    if (!this.booted) {
      throw new Error('VaultSecretsProvider not booted; call boot() before reads');
    }
  }

  private kvPath(key: string): string {
    return `${this.config.kvMount}/data/${this.config.kvPrefix}/${key}`;
  }

  // ---------- reads ----------
  async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
    this.ensureBooted();
    const path = this.kvPath(key);
    try {
      const res = (await this.client.read(path)) as
        | { data?: { data?: { value?: string } } }
        | undefined;
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
      const res = (await this.client.read(path)) as
        | { data?: { data?: { value?: string } } }
        | undefined;
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

  async getSecrets(
    keys: string[],
    opts?: SecretFetchOptions,
  ): Promise<Record<string, string>> {
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
      return {
        ok,
        latencyMs: Date.now() - t0,
        provider: 'vault',
        detail: ok ? 'active' : `initialized=${h?.initialized} sealed=${h?.sealed}`,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        provider: 'vault',
        detail: (err as Error).message,
      };
    }
  }

  // ---------- transit (Phase 4 helpers) ----------
  async encrypt(plaintext: Buffer): Promise<string> {
    this.ensureBooted();
    const path = `${this.config.transitMount}/encrypt/${this.config.transitKey}`;
    const res = await this.client.write(path, {
      plaintext: plaintext.toString('base64'),
    });
    const ct = (res as { data?: { ciphertext?: string } })?.data?.ciphertext;
    if (!ct) throw new Error('VaultSecretsProvider.encrypt: empty ciphertext from transit');
    return ct;
  }

  async decrypt(ciphertext: string): Promise<Buffer> {
    this.ensureBooted();
    const path = `${this.config.transitMount}/decrypt/${this.config.transitKey}`;
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
