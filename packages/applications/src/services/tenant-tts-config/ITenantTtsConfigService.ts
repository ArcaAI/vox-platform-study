import { EffectiveTtsConfigResponse, TenantTtsConfigResponse, TtsPlatformCatalogResponse, UpdateTenantTtsConfigRequest } from './dto';

/**
 * @deprecated TASK-862 — removed in R3. `TenantTtsConfig` (voice / language /
 * format routing per tenant) is replaced by a TTS Agent + `AgentAssignment`
 * (TASK-863). Reads keep working through the window; do not add writers.
 *
 * Per-tenant TTS configuration service — the non-credential SPEC only (voices,
 * routing, platform limits). BYO provider credentials live on the unified
 * `IProviderConnectionService` (`service='tts'`) — edited on
 * `admin/providers/tts/:provider` (the former `admin/tts-config/credentials/**`
 * facade was removed by TASK-862) and injected by the gateway sites
 * (`SpeechProxyController`, `TtsWsGateway`) directly, never through this service.
 *
 * `tenantId` is resolved by the controller (a tenant admin is pinned to their
 * CLS tenant; a platform admin may target another tenant or the SYSTEM default).
 */
export abstract class ITenantTtsConfigService {
  /** Raw persisted row for a tenant (version:0 placeholder when none). */
  abstract getRow(tenantId: string): Promise<TenantTtsConfigResponse>;

  /** Resolved spec: tenant row over the SYSTEM default, clamped to platform limits. */
  abstract getEffective(tenantId: string): Promise<EffectiveTtsConfigResponse>;

  /**
   * Platform TTS catalog derived from the AiModel registry (SYSTEM
   * ENABLED TEXT_TO_SPEECH rows; code-constant fallback pre-seed).
   */
  abstract getPlatformCatalog(): Promise<TtsPlatformCatalogResponse>;

  /** Create (expectedVersion 0) or compare-and-set the tenant's config row. */
  abstract upsertRow(tenantId: string, dto: UpdateTenantTtsConfigRequest): Promise<TenantTtsConfigResponse>;
}
