import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AiProviderConnectionServiceModule } from '../../ai-provider-connection/ai-provider-connection.service.module';
import { AiModelDownloadService } from './ai-model-download.service';
import { HuggingFaceModelSourceClient } from './huggingface-model-source.client';
import { ModelPublisherJobsService } from './model-publisher-jobs.service';
import { publisherCancelFlagsProvider } from './publisher-cancel-flags';

/**
 * AiModelDownloadProducerModule — the PRODUCER half of the model publisher
 * (TASK-1019 OD-1), and the only half `hope-api` imports: the
 * `DownloadAiModel` BullMQ queue registration and `AiModelDownloadService`
 * (trigger + status poll), plus the Hub client the registry routes use to read
 * a repo's card and file list.
 *
 * It deliberately provides NO `@Processor`. The consumer —
 * `AiModelDownloadProcessor`, which fetches, stages and publishes weights and
 * deletes them on unregister — lives in `AiModelPublisherWorkerModule`, booted
 * only by the dedicated model-publisher worker (`model-publisher.main.ts`),
 * the one process holding the `hope-models` write/delete credential. A
 * processor provided here would make every gateway pod consume publish jobs
 * again, in a process with neither that credential nor staging space.
 *
 * `AiProviderConnectionServiceModule` supplies `IProviderConnectionService`,
 * which `HuggingFaceModelSourceClient` uses to resolve the platform's
 * HuggingFace token — Nest DI is resolved per-module, so this import is
 * required even though `AiModelModule` (apps/api) imports it as well.
 */
@Module({
  imports: [
    HttpModule,
    CommonServiceModule,
    CoreDatabaseModule,
    AiProviderConnectionServiceModule,
    BullModule.registerQueue({ name: JobQueue.DownloadAiModel }),
  ],
  // TASK-1023 D-C — job control (cancel + list) and the Redis cancel flag it sets.
  providers: [AiModelDownloadService, HuggingFaceModelSourceClient, ModelPublisherJobsService, publisherCancelFlagsProvider],
  exports: [AiModelDownloadService, HuggingFaceModelSourceClient, ModelPublisherJobsService],
})
export class AiModelDownloadProducerModule {}

/**
 * The pre-TASK-1019 name, kept so existing importers resolve to the SAME
 * module (Nest identifies a module by its class). It is the producer only now.
 * @deprecated import `AiModelDownloadProducerModule`.
 */
export const AiModelDownloadServiceModule = AiModelDownloadProducerModule;
