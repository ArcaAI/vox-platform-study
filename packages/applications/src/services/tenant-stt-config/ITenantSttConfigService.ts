import { PipelineResponse } from '../stt/pipeline';
import {
  EffectiveSttConfigResponse,
  SetSttCredentialRequest,
  SetSttFallbackRequest,
  SttCredentialResponse,
  TenantSttConfigResponse,
  TestSttCredentialRequest,
  TestSttCredentialResponse,
} from './dto';
import { SttProviderOverrides } from './platform-limits';

/**
 * Per-tenant STT fallback + BYOK configuration service.
 *
 * `tenantId` is resolved by the controller (a tenant admin is pinned to their
 * CLS tenant; a platform admin may target another tenant or the SYSTEM default).
 * Mirrors `ITenantTtsConfigService`; STT has a single fallback pointer instead of
 * TTS routing chains.
 */
export abstract class ITenantSttConfigService {
  /** Raw persisted row for a tenant (version:0 placeholder when none). */
  abstract getRow(tenantId: string): Promise<TenantSttConfigResponse>;

  /** Resolved fallback spec: tenant row over the SYSTEM default. */
  abstract getEffective(tenantId: string): Promise<EffectiveSttConfigResponse>;

  /**
   * Set the tenant's default fallback pipeline (+ auto-switch knobs). Validates
   * the target pipeline (tenant-visible, ENABLED, cloud-engine-backed) then
   * creates (expectedVersion 0) or compare-and-sets the config row.
   */
  abstract setFallbackPipeline(tenantId: string, dto: SetSttFallbackRequest): Promise<TenantSttConfigResponse>;

  /**
   * The pipelines a tenant may legitimately point its fallback at: enabled and
   * cloud-engine-backed (the same validation `setFallbackPipeline` enforces on
   * write). Backs the admin picker so it only offers valid targets.
   */
  abstract getFallbackCandidates(tenantId: string): Promise<PipelineResponse[]>;

  /** Masked list of a tenant's BYO provider credentials (never the key). */
  abstract getCredentials(tenantId: string): Promise<SttCredentialResponse[]>;

  /** Set or rotate a tenant's BYO key for a provider (encrypted at rest, OCC-guarded). */
  abstract setCredential(tenantId: string, provider: string, dto: SetSttCredentialRequest): Promise<SttCredentialResponse>;

  /** Remove a tenant's BYO credential for a provider. */
  abstract removeCredential(tenantId: string, provider: string): Promise<void>;

  /**
   * Ephemeral "Test connection" probe: validates an apiKey/region/endpoint
   * combination BEFORE it is saved (or independent of whether it ever is —
   * the saved key is write-only and never returned for re-testing). Never
   * persisted, never logged, never touches Vault.
   */
  abstract testCredential(tenantId: string, provider: string, dto: TestSttCredentialRequest): Promise<TestSttCredentialResponse>;

  /** Decrypt enabled BYO credentials into the gateway-injectable overrides map. */
  abstract resolveProviderOverrides(tenantId: string): Promise<SttProviderOverrides>;
}
