import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { AiModelRepository, JobQueue } from '@arcaai/domains';
import { IS3Service } from '../../../baseServices/storage';
import { assertEqualTenants, createWorkerSession } from '../../../../common';
import { IActiveUserContext } from '../../../../interfaces';
import { mergeDownloadMeta } from './model-download-meta.util';
import { buildAiModelManifest } from './model-manifest.util';
import { ModelSourceFetcherService } from './model-source-fetcher.service';
import { buildSha256SumsContent, deriveModelVersion, deriveQuantTokenFromFilenames, normalizeQuantToken } from './model-version.util';

/**
 * The `hope-models` bucket — see `infrastructure/docker/minio/README.md`
 * A bucket name, not tenant/environment config: every other consumer of this
 * bucket (STT's `StoragePathResolver`, harness) hardcodes the same literal
 * (`model_bucket: str = "hope-models"`), and MinIO credentials/endpoint —
 * the part that actually varies per environment — resolve through the
 * existing `IS3Service` (AppSettings `S3_ENDPOINT` + `SecretsService`
 * `S3_ACCESS_KEY`/`S3_SECRET_KEY`), never a new env var here.
 */
export const HOPE_MODELS_BUCKET = 'hope-models';

/** Mount point of the s3fs sidecar that serves `hope-models` inside a pod. */
const HOPE_MODELS_MOUNT = '/mnt/models-bucket';

export interface DownloadAiModelJobPayload {
  jobId: string;
  aiModelId: string;
  tenantId: string;
  userId?: string;
}

export interface DownloadAiModelResult {
  aiModelId: string;
  sourceUri: string;
  localPath: string;
  fileSizeMb: number;
  sha256: string | null;
}

/**
 * AiModelDownloadProcessor — fetches a model's weights from its current
 * `sourceUri`, verifies + content-addresses them, publishes them into
 * `hope-models`, and writes the `AiModel` row back to point at the
 * published copy.
 *
 * Mirrors `IngestKnowledgeDocumentProcessor`/`DirectorySyncProcessor`: a
 * fail-closed `tenantId` guard, a CLS rebind via `createWorkerSession`
 * (workers run outside the API's ClsModule middleware), and
 * `assertEqualTenants` defense-in-depth against a stale payload.
 *
 * The DOWNLOADING transition itself is NOT made here — `AiModelDownloadService
 * .triggerDownload` already wrote it synchronously before enqueueing, so a
 * rapid double-POST is caught before this worker ever runs. This processor
 * only ever transitions DOWNLOADING -> DOWNLOADED or DOWNLOADING ->
 * DOWNLOAD_FAILED.
 */
@Processor(JobQueue.DownloadAiModel)
export class AiModelDownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(AiModelDownloadProcessor.name);

  constructor(
    private readonly aiModelRepository: AiModelRepository,
    private readonly modelSourceFetcher: ModelSourceFetcherService,
    @Inject(IS3Service) private readonly s3Service: IS3Service,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {
    super();
  }

  async process(job: Job<DownloadAiModelJobPayload>): Promise<DownloadAiModelResult> {
    const { jobId, aiModelId, tenantId, userId } = job.data;
    if (!tenantId) {
      throw new Error(`Job ${jobId ?? job.id} is missing required tenantId`);
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId, tenantId, kind: 'ai-model-download' }));

      const model = await this.aiModelRepository.findById(aiModelId);
      if (!model) {
        throw new Error(`AiModel ${aiModelId} not found`);
      }
      assertEqualTenants(model, { tenantId });

      try {
        await job.updateProgress(10);

        const quantHint = model.computeType ?? null;
        const files = await this.modelSourceFetcher.fetch(model.sourceUri, quantHint);
        if (files.length === 0) {
          throw new Error(`No files fetched for AiModel ${aiModelId} from '${model.sourceUri}'`);
        }

        await job.updateProgress(50);

        const sha256sumsContent = buildSha256SumsContent(files);
        const quant = quantHint ? normalizeQuantToken(quantHint) : deriveQuantTokenFromFilenames([model.sourceUri, ...files.map((f) => f.path)]);
        const version = deriveModelVersion(quant, sha256sumsContent);
        const prefix = `${model.slug}/${version}/`;

        const manifest = buildAiModelManifest({
          slug: model.slug,
          version,
          quant,
          format: model.format,
          sourceUri: model.sourceUri,
          files,
          publishedBy: userId ?? 'system',
        });

        for (const file of files) {
          await this.s3Service.putFile(HOPE_MODELS_BUCKET, `${prefix}${file.path}`, file.data);
        }
        await this.s3Service.putFile(HOPE_MODELS_BUCKET, `${prefix}SHA256SUMS`, Buffer.from(sha256sumsContent, 'utf8'));
        await this.s3Service.putFile(HOPE_MODELS_BUCKET, `${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

        await job.updateProgress(90);

        const totalBytes = files.reduce((sum, f) => sum + f.data.length, 0);
        const fileSizeMb = Math.max(1, Math.round(totalBytes / (1024 * 1024)));
        const primarySha256 = manifest.primaryObject
          ? (files.find((f) => f.path === manifest.primaryObject)?.sha256 ?? files[0].sha256)
          : (files[0]?.sha256 ?? null);
        const sourceUri = `s3://${HOPE_MODELS_BUCKET}/${prefix}`;
        const localPath = `${HOPE_MODELS_MOUNT}/${prefix}`;

        // Re-read: the row's `_version` may have moved since this job started
        // (e.g. an admin edit) — the CAS below is against the CURRENT row.
        const fresh = await this.aiModelRepository.findById(aiModelId);
        if (!fresh) {
          throw new Error(`AiModel ${aiModelId} disappeared during download`);
        }
        fresh.markAsDownloaded(localPath, fileSizeMb, primarySha256 ?? undefined, userId);
        fresh.sourceUri = sourceUri;
        fresh.metaData = mergeDownloadMeta(fresh.metaData, { jobId, finishedAt: new Date().toISOString(), error: null });
        await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);

        await job.updateProgress(100);

        this.logger.log({ message: 'AiModel download completed', jobId, aiModelId, sourceUri, localPath, fileSizeMb });

        return { aiModelId, sourceUri, localPath, fileSizeMb, sha256: primarySha256 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ message: 'AiModel download failed', jobId, aiModelId, error: message });

        const fresh = await this.aiModelRepository.findById(aiModelId);
        if (fresh) {
          fresh.markAsDownloadFailed(userId);
          fresh.metaData = mergeDownloadMeta(fresh.metaData, { jobId, finishedAt: new Date().toISOString(), error: message });
          await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);
        }

        throw error;
      }
    });
  }
}
