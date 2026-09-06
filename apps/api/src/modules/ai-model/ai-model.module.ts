import {
  AiModelDownloadServiceModule,
  AiModelServiceModule,
  AiProviderConnectionServiceModule,
  CommonServiceModule,
  ModelInventoryServiceModule,
} from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiModelAdminController } from './ai-model-admin.controller';
import { AiModelCatalogueController } from './ai-model-catalogue.controller';
import { AiModelDiscoveryController } from './ai-model-discovery.controller';
import { AiModelDiscoveryService } from './ai-model-discovery.service';

/**
 * Wires the admin AI model controller to the
 * already-existing `AiModelService`. Mirrors `PipelineModule`.
 *
 * Also wires the discovery surface (merge view + explicit register). It needs
 * `HttpModule` to reach TEXT's provider aggregator, `CommonServiceModule` for
 * `IConfigService` (`TEXT_URL`) / `SecretsService` — direct `process.env` reads
 * for downstream URLs are lint-banned in `src/modules/**` — and
 * `AiProviderConnectionServiceModule` so discovery can ask the ONE cascade which
 * engine each provider means for the calling tenant (see the service header).
 *
 * `AiModelDownloadServiceModule` wires the download/publish action
 * lane L3): the `DownloadAiModel` BullMQ queue, the trigger/status-poll
 * service `AiModelAdminController` injects, and the fetch/verify/publish
 * worker. `ModelInventoryServiceModule` (TASK-860) wires the on-demand
 * bucket inventory + its settings-gated cron.
 */
@Module({
  imports: [
    AiModelServiceModule,
    AiModelDownloadServiceModule,
    ModelInventoryServiceModule,
    AiProviderConnectionServiceModule,
    CommonServiceModule,
    HttpModule,
  ],
  // ORDER MATTERS: Nest registers routes in controller order,
  // and `AiModelAdminController` carries `GET ':id'` — if it registers first it
  // captures `GET admin/ai-models/discovery` as id="discovery" (404). The
  // discovery controller's static paths must register BEFORE the `:id` family
  // (same static-route-wins rule as the settings registry). TASK-890's
  // `GET admin/ai-models/catalogue` is static for the same reason and joins them.
  controllers: [AiModelDiscoveryController, AiModelCatalogueController, AiModelAdminController],
  providers: [AiModelDiscoveryService],
})
export class AiModelModule {}
