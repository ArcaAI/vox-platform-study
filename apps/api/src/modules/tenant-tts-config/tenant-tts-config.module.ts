import { Module } from '@nestjs/common';
import { AiProviderConnectionServiceModule, TenantTtsConfigServiceModule } from '@arcaai/applications';
import { TenantTtsConfigAdminController } from './tenant-tts-config-admin.controller';

/**
 * TenantTtsConfigModule — mounts the `/admin/tts-config` surface.
 * `TenantTtsConfigService` (spec: effective resolution + OCC row writes) and
 * `IProviderConnectionService` (BYO credentials, `service='tts'`, TASK-570)
 * both come from `@arcaai/applications`; `ClsService` resolves from its global
 * module.
 */
@Module({
  imports: [TenantTtsConfigServiceModule, AiProviderConnectionServiceModule],
  controllers: [TenantTtsConfigAdminController],
})
export class TenantTtsConfigModule {}
