import { Module } from '@nestjs/common';
import { TenantSttConfigServiceModule } from '@arcaai/applications';
import { TenantSttConfigAdminController } from './tenant-stt-config-admin.controller';

/**
 * TenantSttConfigModule — mounts the `/admin/stt-config` surface.
 * `TenantSttConfigService` (effective fallback resolution + OCC row/credential
 * writes) comes from `@arcaai/applications`; `ClsService` resolves from its
 * global module.
 */
@Module({
  imports: [TenantSttConfigServiceModule],
  controllers: [TenantSttConfigAdminController],
})
export class TenantSttConfigModule {}
