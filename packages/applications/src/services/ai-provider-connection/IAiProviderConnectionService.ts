import { AiProviderConnectionEntity } from '@arcaai/domains';
import { AiProviderConnectionResponse, UpsertAiProviderConnectionRequest } from './dto';

/** The resolved connection plus which cascade tier supplied it. */
export interface ResolvedProviderConnection {
  provider: string;
  baseUrl: string | null;
  region: string | null;
  apiVersion: string | null;
  deploymentName: string | null;
  /** Ciphertext — gateway-side decrypt only; never leaves the server. */
  encryptedApiKey: Uint8Array | null;
  keyVersion: number | null;
  /** Which tier won: the caller's own row or the SYSTEM platform default. */
  source: 'tenant' | 'system';
}

/**
 * TASK-526 — one decrypted tenant BYO credential in the shape the SMR service
 * consumes. snake_case matches the frozen wire contract (and the TTS
 * `provider_overrides` precedent); TASK-525 owns the Python-side consumption.
 */
export interface LlmProviderOverrideEntry {
  api_key: string;
  base_url?: string;
  region?: string;
  api_version?: string;
  deployment_name?: string;
}

/** `provider → override`, keyed by the serving provider identifier. */
export type LlmProviderOverrides = Record<string, LlmProviderOverrideEntry>;

export const IAiProviderConnectionService = Symbol('IAiProviderConnectionService');

export interface IAiProviderConnectionService {
  /** Every ENABLED connection row for a tenant, masked. */
  list(tenantId?: string): Promise<AiProviderConnectionResponse[]>;

  /** One (tenant, provider) row, masked; a `version: 0` placeholder when absent. */
  getRow(provider: string, tenantId?: string): Promise<AiProviderConnectionResponse>;

  /** Create-or-CAS-update one (tenant, provider) row. */
  upsertRow(provider: string, dto: UpsertAiProviderConnectionRequest, tenantId?: string): Promise<AiProviderConnectionResponse>;

  /** Soft-delete one (tenant, provider) row. */
  deleteRow(provider: string, tenantId?: string): Promise<void>;

  /**
   * The resolution cascade: ENABLED tenant row → ENABLED SYSTEM row → null.
   * `null` is the "no DB opinion — use the service's env configuration" signal.
   * Server-side only; the result carries ciphertext and is never serialized to
   * a client.
   */
  resolveConnection(provider: string, tenantId: string): Promise<ResolvedProviderConnection | null>;

  /** Raw entity accessor for gateway resolution paths that need the row itself. */
  findRow(provider: string, tenantId: string): Promise<AiProviderConnectionEntity | null>;

  /**
   * TASK-526 — decrypt a tenant's ENABLED **cloud BYO** connections into the
   * injectable `provider_overrides` map the gateway folds into the SMR generate
   * body. Gateway-only: the result carries plaintext key material and is NEVER
   * returned by any read API.
   *
   * FAILS OPEN PER CREDENTIAL, on decrypt error only: a credential whose
   * ciphertext will not decrypt (Vault down, key rotated badly, corrupt bytes)
   * is skipped with a non-secret `warn` so the request proceeds on the
   * SYSTEM/env platform credentials. Model/provider SELECTION stays fail-closed
   * elsewhere — these are different failure classes.
   */
  resolveTenantCloudOverrides(tenantId: string): Promise<LlmProviderOverrides>;
}
