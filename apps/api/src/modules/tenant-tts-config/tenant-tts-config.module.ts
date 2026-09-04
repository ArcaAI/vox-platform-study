import { Module } from '@nestjs/common';
import { TenantTtsConfigServiceModule } from '@arcaai/applications';
import { TenantTtsConfigAdminController } from './tenant-tts-config-admin.controller';

/**
 * TenantTtsConfigModule — mounts the `/admin/tts-config` surface (DEPRECATED
 * by TASK-862, removed in R3 with `TenantTtsConfig`). The BYO credential facade
 * this module used to host moved to `admin/providers/tts/:provider`, so the
 * provider-connection module import went with it.
 */
@Module({
  imports: [TenantTtsConfigServiceModule],
  controllers: [TenantTtsConfigAdminController],
})
export class TenantTtsConfigModule {}
