import { AiProviderConnectionEntity } from '@arcaai/domains';
import { ProviderService } from './constants';
import { AiProviderConnectionResponse, UpsertAiProviderConnectionRequest } from './dto';

export type { ProviderService } from './constants';

/** The resolved connection plus which cascade tier supplied it. */
export interface ResolvedProviderConnection {
  service: ProviderService;
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
 * One decrypted tenant BYO credential in the shape the Python services
 * consume. snake_case matches the frozen wire contract (C4) and the TTS
 * `provider_overrides` precedent.
 */
export interface ProviderOverrideEntry {
  api_key: string;
  base_url?: string;
  region?: string;
  api_version?: string;
  deployment_name?: string;
  /**
   * Providers whose per-request model/target lives in no dedicated column carry
   * it in the connection row's `extraJson` (the console writes it there): an
   * OpenAI/Anthropic/STT `model` override, and Vertex's GCP `project`/`location`.
   * Forwarded verbatim so the Python adapter can target the tenant's resource.
   */
  model?: string;
  project?: string;
  location?: string;
}

/** `provider → override`, keyed by the serving provider identifier. */
export type ProviderOverrides = Record<string, ProviderOverrideEntry>;

// C2 published aliases — the program doc names these; downstream lanes import them.
export type ProviderConnectionResponse = AiProviderConnectionResponse;
export type ResolvedConnection = ResolvedProviderConnection;
export type ProviderOverride = ProviderOverrideEntry;

// ── Deprecated pre-unification type names (kept one release) ────────────────
/** @deprecated Use `ProviderOverrideEntry`. */
export type LlmProviderOverrideEntry = ProviderOverrideEntry;
/** @deprecated Use `ProviderOverrides`. */
export type LlmProviderOverrides = ProviderOverrides;

/**
 * DI token for the unified provider-connection service. The pre-unification
 * `IAiProviderConnectionService` symbol below is an ALIAS to this same value, so
 * existing `@Inject(IAiProviderConnectionService)` sites (smr-proxy) keep
 * resolving until TASK-572 repoints them.
 */
export const IProviderConnectionService = Symbol('IProviderConnectionService');

/** @deprecated Use `IProviderConnectionService` (same symbol value). */
export const IAiProviderConnectionService = IProviderConnectionService;

export interface IProviderConnectionService {
  /** Every ENABLED connection row for a (service, tenant), masked. */
  list(service: ProviderService, tenantId?: string): Promise<AiProviderConnectionResponse[]>;

  /** One (service, tenant, provider) row, masked; a `version: 0` placeholder when absent. */
  getRow(service: ProviderService, provider: string, tenantId?: string): Promise<AiProviderConnectionResponse>;

  /**
   * Create-or-CAS-update one (service, tenant, provider) row. `expectedVersion`
   * is the optimistic-concurrency token (C2). When omitted it falls back to
   * `dto.expectedVersion`, so the gateway may pass it either way.
   */
  upsertRow(
    service: ProviderService,
    provider: string,
    dto: UpsertAiProviderConnectionRequest,
    tenantId?: string,
    expectedVersion?: number,
  ): Promise<AiProviderConnectionResponse>;

  /** Soft-delete one (service, tenant, provider) row. */
  deleteRow(service: ProviderService, provider: string, tenantId?: string, expectedVersion?: number): Promise<void>;

  /**
   * The resolution cascade for one service: ENABLED tenant row → ENABLED SYSTEM
   * row → null. `null` is the "no DB opinion — use the service's env
   * configuration" signal. Server-side only; the result carries ciphertext and
   * is never serialized to a client.
   */
  resolveConnection(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedProviderConnection | null>;

  /** Raw entity accessor for gateway resolution paths that need the row itself. */
  findRow(service: ProviderService, provider: string, tenantId: string): Promise<AiProviderConnectionEntity | null>;

  /**
   * Decrypt a tenant's ENABLED **cloud BYO** connections for one service into
   * the injectable `provider_overrides` map the gateway folds into the Python
   * service body. Gateway-only: the result carries plaintext key material and is
   * NEVER returned by any read API.
   *
   * FAILS OPEN PER CREDENTIAL, on decrypt error only: a credential whose
   * ciphertext will not decrypt (Vault down, key rotated badly, corrupt bytes)
   * is skipped with a non-secret `warn` ({tenantId, service, provider,
   * keyVersion}) so the request proceeds on the SYSTEM/env platform credentials.
   * Model/provider SELECTION stays fail-closed elsewhere — different failure
   * classes.
   *
   * The 1-arg overload is a `@deprecated` transition shim (assumes
   * `service='llm'`) so the (TASK-572-owned) smr-proxy keeps compiling until it
   * repoints; TASK-572 removes it.
   */
  resolveTenantCloudOverrides(service: ProviderService, tenantId: string): Promise<ProviderOverrides>;
  /** @deprecated 1-arg form assumes `service='llm'`; kept for the smr-proxy transition (TASK-572 removes it). */
  resolveTenantCloudOverrides(tenantId: string): Promise<ProviderOverrides>;
}

/** @deprecated Use `IProviderConnectionService`. */
export type IAiProviderConnectionService = IProviderConnectionService;
