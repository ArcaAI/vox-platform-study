import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../../../baseServices';
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
 */
@Module({
  imports: [HttpModule, CommonServiceModule, CoreDatabaseModule, BullModule.registerQueue({ name: JobQueue.DownloadAiModel })],
  providers: [AiModelDownloadService, AiModelDownloadProcessor, ModelSourceFetcherService, HuggingFaceModelSourceClient],
  exports: [AiModelDownloadService],
})
export class AiModelDownloadServiceModule {}
