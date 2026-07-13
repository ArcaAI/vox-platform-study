import { Module } from '@nestjs/common';
import { DirectorySyncServiceModule, TenantIdpConfigServiceModule } from '@arcaai/applications';
import { TenantIdpConfigAdminController } from './tenant-idp-config-admin.controller';

/**
 * TenantIdpConfigModule (TASK-498) — mounts the `/admin/tenant-idp-config`
 * surface. `TenantIdpConfigService` (CRUD + Vault seal + test-connection)
 * and `DirectorySyncService` (P3 — admin-triggered directory pull) come from
 * `@arcaai/applications`; `ClsService` resolves from its global module.
 */
@Module({
  imports: [TenantIdpConfigServiceModule, DirectorySyncServiceModule],
  controllers: [TenantIdpConfigAdminController],
})
export class TenantIdpConfigModule {}
