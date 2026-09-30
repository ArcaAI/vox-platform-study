import {
  AiModelDownloadProducerModule,
  AiModelServiceModule,
  AiProviderConnectionServiceModule,
  CommonServiceModule,
  ModelInventoryServiceModule,
  ModelPathRegistrationServiceModule,
  ModelRegistryAccessServiceModule,
} from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiModelAdminController } from './ai-model-admin.controller';
import { AiModelCatalogueController } from './ai-model-catalogue.controller';
import { AiModelDiscoveryController } from './ai-model-discovery.controller';
import { AiModelDiscoveryService } from './ai-model-discovery.service';
import { AiModelJobsController } from './ai-model-jobs.controller';
import { AiModelRegistrationController } from './ai-model-registration.controller';

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
 * `AiModelDownloadProducerModule` wires the PRODUCER half of the
 * download/publish action: the `DownloadAiModel` BullMQ queue and the
 * trigger/status-poll service `AiModelAdminController` injects. The consumer
 * (fetch/stage/publish + unregister) is NOT here — since TASK-1019 it runs only
 * in the model-publisher worker (`model-publisher.main.ts`), the one process
 * holding the `hope-models` write/delete credential.
 * `ModelInventoryServiceModule` (TASK-860) wires the on-demand bucket
 * inventory + its settings-gated cron.
 */
@Module({
  imports: [
    AiModelServiceModule,
    AiModelDownloadProducerModule,
    ModelInventoryServiceModule,
    ModelRegistryAccessServiceModule,
    ModelPathRegistrationServiceModule,
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
  // TASK-1023: the registration (local path) and job-control controllers carry static
  // paths too, so they also register before the admin controller.
  controllers: [AiModelDiscoveryController, AiModelCatalogueController, AiModelRegistrationController, AiModelJobsController, AiModelAdminController],
  providers: [AiModelDiscoveryService],
})
export class AiModelModule {}
