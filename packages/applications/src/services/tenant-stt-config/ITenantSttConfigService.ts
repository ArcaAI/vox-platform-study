import { PipelineResponse } from '../stt/pipeline';
import { EffectiveSttConfigResponse, SetSttFallbackRequest, TenantSttConfigResponse } from './dto';
import { SttProviderOverrides } from './platform-limits';

/**
 * Per-tenant STT fallback configuration service.
 *
 * TASK-862 removed the BYO credential facade (`getCredentials` /
 * `setCredential` / `removeCredential` / `testCredential`): credentials are
 * edited on `admin/providers/:service/:provider` and probed on its `/test`
 * route. Only `resolveProviderOverrides` (the gateway injection path) survives
 * here. The rest of this service retires under TASK-861.
 *
 * `tenantId` is resolved by the controller (a tenant admin is pinned to their
 * CLS tenant; a platform admin may target another tenant or the SYSTEM default).
 * Mirrors `ITenantTtsConfigService`; STT has a single fallback pointer instead of
 * TTS routing chains.
 */
/** @deprecated TASK-861 — removed in R4. See `TenantSttConfigService`. */
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

  /** Decrypt enabled BYO credentials into the gateway-injectable overrides map. */
  abstract resolveProviderOverrides(tenantId: string): Promise<SttProviderOverrides>;
}
