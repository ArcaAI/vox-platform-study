import { TenantFrontendConfigResponse, UpsertTenantFrontendConfigRequest } from './dto';

/**
 * Per-tenant frontend audio-pipeline defaults (TASK-328 A6). One config row per
 * tenant (`tenantId @unique`), applied to all of that tenant's users.
 *
 * Tenant scoping mirrors the other admin services: a global admin
 * (SUPER_ADMIN / GLOBAL_ADMIN) targets a tenant via the `tenantId` argument;
 * a tenant admin is pinned to their CLS tenant and any `tenantId` is ignored.
 */
export abstract class ITenantFrontendConfigService {
  /** The tenant's frontend config, or `null` when it has not been set yet. */
  abstract getByTenant(tenantId?: string): Promise<TenantFrontendConfigResponse | null>;

  /** Create-or-update the tenant's frontend config (OCC on update). */
  abstract upsert(dto: UpsertTenantFrontendConfigRequest, tenantId?: string): Promise<TenantFrontendConfigResponse>;
}
