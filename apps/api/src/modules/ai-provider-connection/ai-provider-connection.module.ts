import { AiProviderConnectionServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AiProviderConnectionController } from './ai-provider-connection.controller';

/**
 * AiProviderConnectionModule (TASK-524) — mounts the `/admin/ai-providers`
 * surface. `AiProviderConnectionService` (tenant→SYSTEM resolution, the
 * cloud-BYO tenant-lane rule, Vault-encrypted keys, OCC row writes) comes from
 * `@arcaai/applications`; `ClsService` resolves from its global module.
 */
@Module({
  imports: [AiProviderConnectionServiceModule],
  controllers: [AiProviderConnectionController],
})
export class AiProviderConnectionModule {}
