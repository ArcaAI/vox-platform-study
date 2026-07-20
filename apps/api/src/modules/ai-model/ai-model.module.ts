import { AiModelServiceModule, CommonServiceModule } from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiModelAdminController } from './ai-model-admin.controller';
import { AiModelDiscoveryController } from './ai-model-discovery.controller';
import { AiModelDiscoveryService } from './ai-model-discovery.service';

/**
 * TASK-356 Phase 1 (Catalog plane) — wires the admin AI model controller to the
 * already-existing `AiModelService`. Mirrors `PipelineModule`.
 *
 * TASK-528 adds the discovery surface (merge view + explicit register). It needs
 * `HttpModule` to reach SMR's provider aggregator and `CommonServiceModule` for
 * `IConfigService` (`SMR_URL`) / `SecretsService` — direct `process.env` reads
 * for downstream URLs are lint-banned in `src/modules/**`.
 */
@Module({
  imports: [AiModelServiceModule, CommonServiceModule, HttpModule],
  controllers: [AiModelAdminController, AiModelDiscoveryController],
  providers: [AiModelDiscoveryService],
})
export class AiModelModule {}
