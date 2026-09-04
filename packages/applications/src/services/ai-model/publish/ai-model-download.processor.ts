import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { AiModelRepository, JobQueue } from '@arcaai/domains';
import { IS3Service } from '../../baseServices/storage';
import { assertEqualTenants, createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { HF_CACHE_LIBRARIES, HOPE_MODELS_BUCKET, deriveLocalPath } from '../constants';
import { mergeDownloadMeta } from './model-download-meta.util';
import { buildAiModelManifest } from './model-manifest.util';
import { ModelSourceFetcherService } from './model-source-fetcher.service';
import { HuggingFaceModelSourceClient } from './huggingface-model-source.client';
import { buildSha256SumsContent, deriveModelVersion, deriveQuantTokenFromFilenames, normalizeQuantToken, sha256Hex } from './model-version.util';

// Re-exported for the existing importers (tests, the API module); the constant moved to `../constants`.
export { HOPE_MODELS_BUCKET };

/**
 * Libraries whose loader opens ONE file (so the derived `localPath` names the
 * primary object) rather than a directory.
 */
const SINGLE_FILE_LIBRARIES: ReadonlySet<string> = new Set(['whisper.cpp', 'llama.cpp', 'onnxruntime', 'parakeet.cpp']);

const HF_REPO_RE = /^(?:hf:)?([\w.-]+)\/([\w.-]+)$/;

export interface DownloadAiModelJobPayload {
  jobId: string;
  aiModelId: string;
  tenantId: string;
  userId?: string;
}

export interface DownloadAiModelResult {
  aiModelId: string;
  sourceUri: string;
  bucketPrefix: string;
  localPath: string;
  fileSizeMb: number;
  sha256: string | null;
}

/**
 * AiModelDownloadProcessor — THE publisher of the `hope-models` bucket
 * (TASK-860 D-1): fetches a model's weights from its `sourceUri`, verifies +
 * content-addresses them, publishes them under the layout README §3.3
 * prescribes, and writes the `AiModel` row back with its bucket identity
 * (`bucketPrefix`, `primaryObject`, `manifestDigest`, `hfRevision`), the
 * derived `localPath`, and `availability = AVAILABLE`.
 *
 * Two layouts, one contract:
 *
 *   `<slug>/<version>/manifest.json, SHA256SUMS, <weights…>`     GGUF / CT2 / ONNX / pth — flat
 *   `hf/hub/models--<org>--<repo>/{refs/main, snapshots/<sha>/…}` transformers family — a verbatim
 *                                                               HF cache (`HF_HOME=/mnt/models-bucket/hf`
 *                                                               + `HF_HUB_OFFLINE=1` serves it; no
 *                                                               symlinks, s3fs cannot follow them)
 *
 * The HF-cache layout needs the repo commit sha (the snapshot directory name).
 * When the Hub cannot be reached for it the job falls back to the flat layout
 * rather than inventing a sha — a wrong snapshot name is worse than a flat
 * prefix the resolvers can still read through `localPath`.
 *
 * `sourceUri` is left UNTOUCHED: it is the row's Hub identity (R-3); the bucket
 * location is `bucketPrefix`. (Before TASK-860 the job repointed `sourceUri` at
 * `s3://hope-models/…`, which destroyed the identity the card metadata is
 * mirrored from.)
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
    private readonly hfClient: HuggingFaceModelSourceClient,
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

        // Layout: HF cache for the transformers family (when the Hub sha is
        // known), flat `<slug>/<version>/` for everything else. The sha is
        // recorded as `hfRevision` on EVERY Hub-sourced row, whatever the layout.
        const hub = await this.resolveHubInfo(model.sourceUri);
        const cacheLayout = hub && HF_CACHE_LIBRARIES.has(model.libraryName) ? hub : null;
        const prefix = cacheLayout ? cacheLayout.snapshotPrefix : `${model.slug}/${version}/`;

        const manifest = buildAiModelManifest({
          slug: model.slug,
          version: cacheLayout ? cacheLayout.sha : version,
          quant,
          format: model.format,
          sourceUri: model.sourceUri,
          files,
          publishedBy: userId ?? 'system',
        });
        const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

        for (const file of files) {
          await this.s3Service.putFile(HOPE_MODELS_BUCKET, `${prefix}${file.path}`, file.data);
        }
        await this.s3Service.putFile(HOPE_MODELS_BUCKET, `${prefix}SHA256SUMS`, Buffer.from(sha256sumsContent, 'utf8'));
        await this.s3Service.putFile(HOPE_MODELS_BUCKET, `${prefix}manifest.json`, manifestBytes);
        if (cacheLayout) {
          // `refs/main` is what `hf_hub_download` resolves a revision through
          // when offline; without it the snapshot is invisible to the loader.
          await this.s3Service.putFile(HOPE_MODELS_BUCKET, `${cacheLayout.repoPrefix}refs/main`, Buffer.from(cacheLayout.sha, 'utf8'));
        }

        await job.updateProgress(90);

        const totalBytes = files.reduce((sum, f) => sum + f.data.length, 0);
        const fileSizeMb = Math.max(1, Math.round(totalBytes / (1024 * 1024)));
        const primaryObject = manifest.primaryObject;
        const primarySha256 = primaryObject ? (files.find((f) => f.path === primaryObject)?.sha256 ?? files[0].sha256) : (files[0]?.sha256 ?? null);
        const localPath = deriveLocalPath(prefix, SINGLE_FILE_LIBRARIES.has(model.libraryName) ? primaryObject : null);

        // Re-read: the row's `_version` may have moved since this job started
        // (e.g. an admin edit) — the CAS below is against the CURRENT row.
        const fresh = await this.aiModelRepository.findById(aiModelId);
        if (!fresh) {
          throw new Error(`AiModel ${aiModelId} disappeared during download`);
        }
        fresh.recordPublish({
          bucketPrefix: prefix,
          primaryObject,
          manifestDigest: sha256Hex(manifestBytes),
          localPath,
          fileSizeMb,
          checksum: primarySha256 ?? undefined,
          hfRevision: hub?.sha ?? null,
          userId,
        });
        fresh.metaData = mergeDownloadMeta(fresh.metaData, { jobId, finishedAt: new Date().toISOString(), error: null });
        await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);

        await job.updateProgress(100);

        this.logger.log({
          message: 'AiModel published to the models bucket',
          jobId,
          aiModelId,
          sourceUri: model.sourceUri,
          bucketPrefix: prefix,
          localPath,
          fileSizeMb,
        });

        return { aiModelId, sourceUri: model.sourceUri, bucketPrefix: prefix, localPath, fileSizeMb, sha256: primarySha256 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ message: 'AiModel publish failed', jobId, aiModelId, error: message });

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

  /**
   * For a Hub-sourced row: the repo's commit sha and the two prefixes of its
   * HF-cache layout. `null` for a non-Hub source, and for a Hub the job could
   * not reach (the caller then publishes flat and records no revision).
   */
  private async resolveHubInfo(sourceUri: string): Promise<{ sha: string; repoPrefix: string; snapshotPrefix: string } | null> {
    const match = sourceUri.match(HF_REPO_RE);
    if (!match) return null;
    const [, org, repo] = match;
    try {
      const info = await this.hfClient.getRepoInfo(`${org}/${repo}`);
      if (!info.sha) return null;
      const repoPrefix = `hf/hub/models--${org}--${repo}/`;
      return { sha: info.sha, repoPrefix, snapshotPrefix: `${repoPrefix}snapshots/${info.sha}/` };
    } catch (error) {
      this.logger.warn({
        message: 'Hub sha unavailable — publishing flat instead of as an HF cache',
        sourceUri,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
