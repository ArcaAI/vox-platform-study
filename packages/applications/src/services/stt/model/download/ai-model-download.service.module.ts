import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../../../baseServices';
import { AiProviderConnectionServiceModule } from '../../../ai-provider-connection/ai-provider-connection.service.module';
import { AiModelDownloadService } from './ai-model-download.service';
import { AiModelDownloadProcessor } from './ai-model-download.processor';
import { ModelSourceFetcherService } from './model-source-fetcher.service';
import { HuggingFaceModelSourceClient } from './huggingface-model-source.client';

/**
 * AiModelDownloadServiceModule — the model download/publish action
 * (TASK-855 lane L3). Wires the `DownloadAiModel` BullMQ queue, the
 * enqueue+status-poll service, the fetch/verify/publish worker, and the
 * HuggingFace/S3 source-fetching helpers.
 *
 * `CommonServiceModule` supplies `IS3Service` (MinIO credentials resolve via
 * its existing `AppSettingsService`/`SecretsService` tiers — no new env var
 * here) and `CoreDatabaseModule` supplies `AiModelRepository`. `HttpModule`
 * is imported directly (not inherited from `CommonServiceModule`) for the
 * HuggingFace client, mirroring `KnowledgeServiceModule`.
 *
 * `AiProviderConnectionServiceModule` (TASK-855 L8) supplies
 * `IProviderConnectionService`, which `HuggingFaceModelSourceClient` uses to
 * resolve the platform's HuggingFace token — Nest DI is resolved per-module,
 * so this import is required even though `AiModelModule` (apps/api) already
 * imports the same module alongside this one.
 */
@Module({
  imports: [
    HttpModule,
    CommonServiceModule,
    CoreDatabaseModule,
    AiProviderConnectionServiceModule,
    BullModule.registerQueue({ name: JobQueue.DownloadAiModel }),
  ],
  providers: [AiModelDownloadService, AiModelDownloadProcessor, ModelSourceFetcherService, HuggingFaceModelSourceClient],
  exports: [AiModelDownloadService],
})
export class AiModelDownloadServiceModule {}
