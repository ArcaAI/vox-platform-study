import { Module } from '@nestjs/common';
import { TenantTtsConfigServiceModule } from '@arcaai/applications';
import { TenantTtsConfigAdminController } from './tenant-tts-config-admin.controller';

/**
 * TenantTtsConfigModule (TASK-496) — mounts the `/admin/tts-config` surface.
 * `TenantTtsConfigService` (effective resolution + OCC row writes) comes from
 * `@arcaai/applications`; `ClsService` resolves from its global module.
 */
@Module({
  imports: [TenantTtsConfigServiceModule],
  controllers: [TenantTtsConfigAdminController],
})
export class TenantTtsConfigModule {}
