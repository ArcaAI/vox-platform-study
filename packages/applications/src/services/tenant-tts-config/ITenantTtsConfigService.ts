import {
  EffectiveTtsConfigResponse,
  SetTtsCredentialRequest,
  TenantTtsConfigResponse,
  TtsCredentialResponse,
  UpdateTenantTtsConfigRequest,
} from './dto';
import { TtsProviderOverrides } from './platform-limits';

/**
 * TASK-496 — per-tenant TTS configuration service.
 *
 * `tenantId` is resolved by the controller (a tenant admin is pinned to their
 * CLS tenant; a platform admin may target another tenant or the SYSTEM default).
 * Credential (BYO-key) methods are added in Phase 6.
 */
export abstract class ITenantTtsConfigService {
  /** Raw persisted row for a tenant (version:0 placeholder when none). */
  abstract getRow(tenantId: string): Promise<TenantTtsConfigResponse>;

  /** Resolved spec: tenant row over the SYSTEM default, clamped to platform limits. */
  abstract getEffective(tenantId: string): Promise<EffectiveTtsConfigResponse>;

  /** Create (expectedVersion 0) or compare-and-set the tenant's config row. */
  abstract upsertRow(tenantId: string, dto: UpdateTenantTtsConfigRequest): Promise<TenantTtsConfigResponse>;

  /** Masked list of a tenant's BYO provider credentials (never the key). */
  abstract getCredentials(tenantId: string): Promise<TtsCredentialResponse[]>;

  /** Set or rotate a tenant's BYO key for a provider (encrypted at rest). */
  abstract setCredential(
    tenantId: string,
    provider: string,
    dto: SetTtsCredentialRequest,
  ): Promise<TtsCredentialResponse>;

  /** Remove a tenant's BYO credential for a provider. */
  abstract removeCredential(tenantId: string, provider: string): Promise<void>;

  /** Decrypt enabled BYO credentials into the gateway-injectable overrides map. */
  abstract resolveProviderOverrides(tenantId: string): Promise<TtsProviderOverrides>;
}
