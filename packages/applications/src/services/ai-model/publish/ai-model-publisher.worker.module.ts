import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AiProviderConnectionServiceModule } from '../../ai-provider-connection/ai-provider-connection.service.module';
import { AiModelDownloadProcessor } from './ai-model-download.processor';
import { HuggingFaceModelSourceClient } from './huggingface-model-source.client';
import { ModelSourceFetcherService } from './model-source-fetcher.service';
import { ModelStoreFactory } from './model-store';
import { AiModelUnregisterService } from './model-unregister.service';
import { ModelUsageReader } from '../lifecycle/model-usage.reader';

/**
 * AiModelPublisherWorkerModule — the CONSUMER half of the model publisher
 * (TASK-1019 OD-1 / D-5): the `DownloadAiModel` processor (download AND
 * unregister jobs), the streaming source fetcher, the Hub client, the
 * publisher’s own `ModelStore` (env-tier key pair on the publisher pod alone, D-2 / C3) and the unregister
 * service. Imported ONLY by the model-publisher worker's root module
 * (`apps/api/src/model-publisher/model-publisher-worker.module.ts`); never by
 * `hope-api`.
 *
 * `CommonServiceModule` supplies `IAppSettingsService`,
 * `IS3Service` (read side of `s3://` sources only — publishes go through
 * `ModelStore`) and the BullMQ root connection; `CoreDatabaseModule` the
 * `AiModelRepository` / `TenantStorageConfigRepository` and the five
 * repositories `ModelUsageReader` needs (the worker re-checks referrers, I9);
 * `AiProviderConnectionServiceModule` the platform HuggingFace token.
 * `EventEmitter2` and `ClsService` (for the unregister sys-event) come from the
 * worker root module's global `EventEmitterModule` / `ClsModule`.
 */
@Module({
  imports: [
    HttpModule,
    CommonServiceModule,
    CoreDatabaseModule,
    AiProviderConnectionServiceModule,
    BullModule.registerQueue({ name: JobQueue.DownloadAiModel }),
  ],
  providers: [
    AiModelDownloadProcessor,
    ModelSourceFetcherService,
    HuggingFaceModelSourceClient,
    ModelStoreFactory,
    AiModelUnregisterService,
    ModelUsageReader,
  ],
})
export class AiModelPublisherWorkerModule {}
