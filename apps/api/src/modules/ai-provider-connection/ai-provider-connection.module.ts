import { AiProviderConnectionServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AiProviderConnectionController, ProviderConnectionController } from './ai-provider-connection.controller';

/**
 * AiProviderConnectionModule — mounts the unified `/admin/providers` surface
 * (`ProviderConnectionController`, keyed by service+provider) PLUS the legacy
 * `/admin/ai-providers` LLM-only alias (`AiProviderConnectionController`, kept
 * one release per C3). Both delegate to the same unified provider-connection
 * service (tenant→SYSTEM resolution, the cloud-BYO tenant-lane rule,
 * Vault-encrypted keys, OCC row writes) from `@arcaai/applications`; `ClsService`
 * resolves from its global module.
 */
@Module({
  imports: [AiProviderConnectionServiceModule],
  controllers: [ProviderConnectionController, AiProviderConnectionController],
})
export class AiProviderConnectionModule {}
