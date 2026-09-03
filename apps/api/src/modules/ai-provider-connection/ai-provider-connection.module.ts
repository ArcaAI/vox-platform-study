import { AiProviderConnectionServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { ProviderConnectionController } from './ai-provider-connection.controller';

/**
 * AiProviderConnectionModule — mounts the unified `/admin/providers` surface
 * (`ProviderConnectionController`, keyed by service+provider, plus the
 * TASK-862 test-connection probe). The legacy `/admin/ai-providers` LLM-only
 * alias was removed by TASK-862 (deprecation register: R1 marked, R3 removed —
 * removed early because no console caller remained). The controller delegates
 * to the unified provider-connection service (tenant→SYSTEM resolution, the
 * cloud-BYO tenant-lane rule, Vault-encrypted keys, OCC row writes) from
 * `@arcaai/applications`; `ClsService` resolves from its global module.
 */
@Module({
  imports: [AiProviderConnectionServiceModule],
  controllers: [ProviderConnectionController],
})
export class AiProviderConnectionModule {}
