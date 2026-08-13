/**
 * ISecretsProvider contract.
 *
 * Every secrets backend (env, vault, aws, azure, in-memory) implements this
 * interface. Consumer code never depends on a concrete provider; it depends
 * on SecretsService which wraps the provider with caching.
 *
 * Stays in @arcaai/applications because the providers wrap NestJS DI
 * primitives. The interface itself is framework-agnostic.
 */

export const SECRETS_PROVIDER_TOKEN = Symbol.for('ISecretsProvider');

export interface SecretFetchOptions {
  /** Cache TTL in seconds; default 300. */
  ttlSec?: number;
  /** If true, throw on missing; if false, return undefined / empty string. Default true. */
  required?: boolean;
  /** Bypass cache for this call. */
  refresh?: boolean;
  /**
   * Read a SPECIFIC kv-v2 version instead of the latest. Vault kv-v2 retains
   * prior versions, which is what makes a STAGED secret rotation possible:
   * during the overlap window, material minted under version N
   * must still be verifiable while new material is minted under N+1.
   *
   * Only the Vault provider can honour it — env / aws / azure / in-memory hold
   * exactly one value per key and IGNORE it. That is deliberate: a dev box must
   * not fail because production is mid-rotation.
   */
  version?: number;
}

export interface SecretsHealth {
  ok: boolean;
  latencyMs: number;
  provider: string;
  /** Optional human-readable detail; never include secret material. */
  detail?: string;
  /**
   * Stale-while-revalidate signal for DB lease rotation. `degraded=true`
   * means at least one
   * registered VaultLeaseRenewer has crossed its failure threshold;
   * `ok` may still be true (cached credentials remain valid until
   * expiry). Health endpoints surface this as a WARNING, not a
   * failure, so already-connected pods keep serving traffic.
   */
  degraded?: boolean;
}

export interface ISecretsProvider {
  /**
   * Which tier this provider reads from. Declared SYNCHRONOUSLY (unlike
   * `health()`, which is a round-trip) so `SecretsService` can attribute every
   * resolved value to a tier without any I/O — "every fallback is
   * observable". Optional so hand-rolled test doubles keep compiling; a
   * provider without one is attributed as `unknown`.
   */
  readonly name?: SecretsProviderName;
  getSecret(key: string, opts?: SecretFetchOptions): Promise<string>;
  getSecretOptional(key: string, opts?: SecretFetchOptions): Promise<string | undefined>;
  getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T>;
  getSecrets(keys: string[], opts?: SecretFetchOptions): Promise<Record<string, string>>;
  rotateSecret(key: string): Promise<void>;
  health(): Promise<SecretsHealth>;
}

export type SecretsProviderName = 'env' | 'vault' | 'aws' | 'azure' | 'in-memory';
