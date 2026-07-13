import {
  CreateTenantIdpConfigRequest,
  SetDirectoryCredentialsRequest,
  TenantIdpConfigResponse,
  TestConnectionResponse,
  UpdateTenantIdpConfigRequest,
} from './dto';

/**
 * TASK-498 — tenant-scoped external OIDC identity provider config.
 * `tenantId` is resolved by the controller (a tenant admin is pinned to their
 * CLS tenant; a global admin may target another tenant).
 */
export abstract class ITenantIdpConfigService {
  /** All (non-deleted) provider rows configured for a tenant. */
  abstract list(tenantId: string): Promise<TenantIdpConfigResponse[]>;

  /** A single provider row, scoped to its owning tenant. */
  abstract getById(tenantId: string, id: string): Promise<TenantIdpConfigResponse>;

  /** Create a new provider row (status starts DRAFT — D7). */
  abstract create(tenantId: string, dto: CreateTenantIdpConfigRequest): Promise<TenantIdpConfigResponse>;

  /** Compare-and-set update of an existing provider row. */
  abstract update(tenantId: string, id: string, dto: UpdateTenantIdpConfigRequest): Promise<TenantIdpConfigResponse>;

  /** Soft-delete a provider row. */
  abstract remove(tenantId: string, id: string): Promise<void>;

  /**
   * Resolve OIDC discovery + construct a client for the configured issuer/
   * clientId/clientSecret. Never drives a full browser login. Success flips
   * `providerStatus` DRAFT → ENABLED (D7); failure leaves it unchanged.
   */
  abstract testConnection(tenantId: string, id: string): Promise<TestConnectionResponse>;

  /**
   * Vault-seal a directory-API credential bundle (P3 — MS Graph / Google
   * Directory) into `directoryCredentialsRef`. Write-only; required before
   * `DirectorySyncService.enqueueSync` will accept a sync trigger for this row.
   */
  abstract setDirectoryCredentials(
    tenantId: string,
    id: string,
    dto: SetDirectoryCredentialsRequest,
  ): Promise<TenantIdpConfigResponse>;
}
