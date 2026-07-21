import { TenantFrontendConfigResponse, UpsertTenantFrontendConfigRequest } from './dto';

/**
 * Per-tenant frontend audio-pipeline defaults. One config row per
 * tenant (`tenantId @unique`), applied to all of that tenant's users.
 *
 * Tenant scoping mirrors the other admin services: a global admin
 * (GLOBAL_ADMIN) targets a tenant via the `tenantId` argument;
 * a tenant admin is pinned to their CLS tenant and any `tenantId` is ignored.
 */
export abstract class ITenantFrontendConfigService {
  /** The tenant's frontend config, or `null` when it has not been set yet. */
  abstract getByTenant(tenantId?: string): Promise<TenantFrontendConfigResponse | null>;

  /** Create-or-update the tenant's frontend config (OCC on update). */
  abstract upsert(dto: UpsertTenantFrontendConfigRequest, tenantId?: string): Promise<TenantFrontendConfigResponse>;

  /**
   * The server-computed SDK-facing enablement for local raw-stream
   * capture: `platformCapability AND tenantToggle`. Surfaced to
   * `GET /tenant/me/config` as the `enable-local-raw-capture` row.
   */
  abstract resolveEffectiveLocalRawCapture(tenantId: string): Promise<boolean>;
}
