import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { AiModelAvailability, AiModelRepository, AiModelSource, JobQueue } from '@arcaai/domains';
import { assertEqualTenants, createWorkerSession } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { HF_CACHE_LIBRARIES, HOPE_MODELS_BUCKET, SINGLE_FILE_LIBRARIES, deriveLocalPath } from '../constants';
import { DownloadHeartbeat, DownloadHeartbeatSnapshot } from './download-heartbeat';
import { mergeDownloadMeta, readDownloadMeta } from './model-download-meta.util';
import { buildAiModelManifest } from './model-manifest.util';
import { ModelPublisherError, NON_RETRYABLE_PUBLISHER_CODES } from './model-publisher.errors';
import { ModelSourceFetcherService } from './model-source-fetcher.service';
import { createStagingDir, removeStagingDir, resolveStagingBaseDir } from './model-staging';
import { ModelStoreFactory } from './model-store';
import { AiModelUnregisterService, UnregisterAiModelResult } from './model-unregister.service';
import { HuggingFaceModelSourceClient } from './huggingface-model-source.client';
import { buildSha256SumsContent, deriveModelVersion, deriveQuantTokenFromFilenames, normalizeQuantToken, sha256Hex } from './model-version.util';
import { isUnregisterJob, type DownloadAiModelJobPayload, type PublisherJobPayload, type UnregisterAiModelJobPayload } from './publisher-job.contract';
import { QUEUE_CONCURRENCY } from '../../baseServices/redis/queue-concurrency';
import { runJobInContext } from '../../baseServices/observability/job-context';

// Re-exported for the existing importers (tests, the API module); the constant moved to `../constants`.
export { HOPE_MODELS_BUCKET };
// The payload type moved to the shared contract (TASK-1019); re-exported for existing importers.
export type { DownloadAiModelJobPayload } from './publisher-job.contract';

const HF_REPO_RE = /^(?:hf:)?([\w.-]+)\/([\w.-]+)$/;

/** Liveness cadence: "at most every few seconds" (D-4). Not a policy knob — staleness is (`staleAfterSeconds`). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

export interface DownloadAiModelResult {
  aiModelId: string;
  sourceUri: string;
  bucketPrefix: string;
  localPath: string;
  fileSizeMb: number;
  sha256: string | null;
}

/** Test/ops seams — none of them is configuration a tenant or operator sets. */
export interface ModelPublisherProcessorOptions {
  /** Base directory for per-job staging dirs; default `MODEL_PUBLISHER_STAGING_DIR` or the OS temp dir. */
  stagingBaseDir?: string;
  heartbeatIntervalMs?: number;
  now?: () => number;
}
export const MODEL_PUBLISHER_PROCESSOR_OPTIONS = Symbol('MODEL_PUBLISHER_PROCESSOR_OPTIONS');

/**
 * AiModelDownloadProcessor — THE publisher of the `hope-models` bucket
 * (TASK-860 D-1), and since TASK-1019 the ONLY consumer of the
 * `DownloadAiModel` queue: it runs in the dedicated model-publisher worker
 * (`apps/api/src/model-publisher.main.ts`), never inside `hope-api`, and
 * executes two job kinds (contract `publisher-job.contract.ts`):
 *
 *   download    fetch a model's weights from its `sourceUri`, STREAM each file
 *               to a job-private staging directory while hashing it, upload
 *               from disk (multipart) through the publisher's own `ModelStore`
 *               credential, and write the row back with its bucket identity
 *               (`bucketPrefix`, `primaryObject`, `manifestDigest`,
 *               `hfRevision`) and `availability = AVAILABLE`;
 *   unregister  delegate to `AiModelUnregisterService` (prefix delete / purge,
 *               soft delete, `ResourceDeleted`).
 * A payload with no `kind` was queued before the contract existed: a download.
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
 * It is resolved FIRST and the fetch is pinned to it, so the snapshot name and
 * the bytes under it can never disagree. When the Hub cannot be reached for it
 * the job fetches `main` and falls back to the flat layout rather than
 * inventing a sha — a wrong snapshot name is worse than a flat prefix the
 * resolvers can still read through `localPath`.
 *
 * `sourceUri` is left UNTOUCHED: it is the row's Hub identity (R-3); the bucket
 * location is `bucketPrefix`.
 *
 * RETRIES (D-4). BullMQ `attempts` is set by the producer. Each attempt is
 * idempotent: a key already in the bucket with the staged file's size is
 * skipped, a size mismatch is re-uploaded. A failure with attempts left keeps
 * the row DOWNLOADING (heartbeat refreshed, no error) for the retry; the final
 * failure — or a coded failure no retry can fix (`NON_RETRYABLE_PUBLISHER_CODES`,
 * thrown as `UnrecoverableError`) — records the error. A worker that dies
 * mid-job stops heart-beating, and readers derive DOWNLOAD_FAILED (STALLED).
 *
 * Mirrors `IngestKnowledgeDocumentProcessor`/`DirectorySyncProcessor`: a
 * fail-closed `tenantId` guard, a CLS rebind via `createWorkerSession`
 * (workers run outside the API's ClsModule middleware), and
 * `assertEqualTenants` defense-in-depth against a stale payload.
 *
 * The DOWNLOADING transition itself is NOT made here — `AiModelDownloadService
 * .triggerDownload` already wrote it synchronously before enqueueing, so a
 * rapid double-POST is caught before this worker ever runs.
 */
// TASK-993 lane D — concurrency is DECLARED, not inherited. Every processor
// ran at bullmq's default of 1 because no `@Processor` passed options; the
// number, and the Prisma-pool budget it fits inside, live in one table.
@Processor(JobQueue.DownloadAiModel, { concurrency: QUEUE_CONCURRENCY[JobQueue.DownloadAiModel] })
export class AiModelDownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(AiModelDownloadProcessor.name);
  private readonly stagingBaseDir: string;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly aiModelRepository: AiModelRepository,
    private readonly modelSourceFetcher: ModelSourceFetcherService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly hfClient: HuggingFaceModelSourceClient,
    private readonly modelStoreFactory: ModelStoreFactory,
    private readonly unregisterService: AiModelUnregisterService,
    @Optional() @Inject(MODEL_PUBLISHER_PROCESSOR_OPTIONS) options?: ModelPublisherProcessorOptions,
  ) {
    super();
    this.stagingBaseDir = options?.stagingBaseDir ?? resolveStagingBaseDir();
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.now = options?.now ?? Date.now;
  }

  async process(job: Job<PublisherJobPayload>): Promise<DownloadAiModelResult | UnregisterAiModelResult> {
    const payload = job.data;
    if (!payload.tenantId) {
      throw new Error(`Job ${payload.jobId ?? job.id} is missing required tenantId`);
    }

    const attempt = (job.attemptsMade ?? 0) + 1;
    const finalAttempt = attempt >= (job.opts?.attempts ?? 1);

    return runJobInContext(this.cls, job, async () => {
      this.cls.set('tenantId', payload.tenantId);
      // One worker identity for both job kinds: the session names the publisher
      // worker, the job kind rides in the logs and the audit event.
      this.cls.set('user', createWorkerSession({ userId: payload.userId, tenantId: payload.tenantId, kind: 'ai-model-download' }));

      if (isUnregisterJob(payload)) {
        return this.runUnregister(payload, finalAttempt);
      }
      return this.runDownload(job, payload, attempt, finalAttempt);
    });
  }

  private async runUnregister(payload: UnregisterAiModelJobPayload, finalAttempt: boolean): Promise<UnregisterAiModelResult> {
    try {
      const result = await this.unregisterService.execute(payload, { finalAttempt });
      this.logger.log({ message: 'AiModel unregistered', jobId: payload.jobId, aiModelId: payload.aiModelId, weights: result.weights, purge: payload.purge });
      return result;
    } catch (error) {
      throw this.toJobError(error, finalAttempt, { jobId: payload.jobId, aiModelId: payload.aiModelId, action: 'unregister' });
    }
  }

  private async runDownload(job: Job, payload: DownloadAiModelJobPayload, attempt: number, finalAttempt: boolean): Promise<DownloadAiModelResult> {
    const { jobId, aiModelId, tenantId, userId } = payload;

    const model = await this.aiModelRepository.findById(aiModelId);
    if (!model) {
      throw new Error(`AiModel ${aiModelId} not found`);
    }
    assertEqualTenants(model, { tenantId });

    let stagingDir: string | null = null;
    let heartbeat: DownloadHeartbeat | null = null;

    try {
      // This attempt is now the live one: clear a previous attempt's outcome,
      // restart the byte counter, stamp liveness.
      const startedAt = readDownloadMeta(model.metaData)?.startedAt ?? this.isoNow();
      model.metaData = mergeDownloadMeta(model.metaData, { jobId, startedAt, finishedAt: null, error: null, attempt, heartbeatAt: this.isoNow(), bytesDone: 0 });
      if (userId) model.updatedBy = userId;
      await this.aiModelRepository.updateWithVersion(aiModelId, model, model.version);

      await job.updateProgress(5);

      // Credential first: without it nothing below may run (D-2, fail closed).
      const store = await this.modelStoreFactory.create();

      // A LOCAL row never reaches the Hub (TASK-960 D1); the fetcher refuses it.
      const hub = model.source === AiModelSource.LOCAL ? null : await this.resolveHubInfo(model.sourceUri, model.sourceRevision ?? null);

      stagingDir = await createStagingDir(this.stagingBaseDir);
      heartbeat = new DownloadHeartbeat((snapshot) => this.writeHeartbeat(aiModelId, jobId, snapshot), {
        intervalMs: this.heartbeatIntervalMs,
        now: this.now,
        onError: (error) => this.logger.warn({ message: 'Download heartbeat write failed', jobId, aiModelId, error: error.message }),
      });
      heartbeat.start();
      const liveHeartbeat = heartbeat;

      const quantHint = model.computeType ?? null;
      const files = await this.modelSourceFetcher.fetch(model.source, model.sourceUri, quantHint, {
        stagingDir,
        revision: hub?.sha,
        onPlanned: (total) => liveHeartbeat.setTotal(total),
        onBytes: (bytes) => liveHeartbeat.addBytes(bytes),
      });
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
        const key = `${prefix}${file.path}`;
        // Retry-safe: an object a previous attempt already published whole is
        // not sent again; a truncated or different one is replaced.
        const existing = await store.headObject(key);
        if (!existing || existing.size !== file.size) {
          await store.uploadFile(key, file.localPath);
        }
        liveHeartbeat.beat();
      }
      await store.putSmall(`${prefix}SHA256SUMS`, Buffer.from(sha256sumsContent, 'utf8'));
      await store.putSmall(`${prefix}manifest.json`, manifestBytes);
      if (cacheLayout) {
        // `refs/main` is what `hf_hub_download` resolves a revision through
        // when offline; without it the snapshot is invisible to the loader.
        // The body is the bare sha — no trailing newline.
        await store.putSmall(`${cacheLayout.repoPrefix}refs/main`, Buffer.from(cacheLayout.sha, 'utf8'));
      }

      await heartbeat.stop();
      await job.updateProgress(90);

      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      const fileSizeMb = Math.max(1, Math.round(totalBytes / (1024 * 1024)));
      const primaryObject = manifest.primaryObject;
      const primarySha256 = primaryObject ? (files.find((f) => f.path === primaryObject)?.sha256 ?? files[0].sha256) : (files[0]?.sha256 ?? null);
      const localPath = deriveLocalPath(prefix, SINGLE_FILE_LIBRARIES.has(model.libraryName) ? primaryObject : null);

      // Re-read: the row's `_version` may have moved since this job started
      // (an admin edit, a heartbeat) — the CAS below is against the CURRENT row.
      const fresh = await this.aiModelRepository.findById(aiModelId);
      if (!fresh) {
        throw new Error(`AiModel ${aiModelId} disappeared during download`);
      }
      // TASK-890 §3.11 — the write-back is the BUCKET IDENTITY plus the
      // MEASURED availability, and nothing else; the published size — a fact
      // about THIS run, not about the row — rides in the run bookkeeping.
      fresh.bucketPrefix = prefix;
      fresh.primaryObject = primaryObject ?? null;
      fresh.manifestDigest = sha256Hex(manifestBytes);
      if (hub?.sha !== undefined) fresh.hfRevision = hub?.sha ?? null;
      if (primarySha256) fresh.checksum = primarySha256;
      if (userId) fresh.updatedBy = userId;
      fresh.markAvailability(AiModelAvailability.AVAILABLE, null);
      fresh.metaData = mergeDownloadMeta(fresh.metaData, {
        jobId,
        finishedAt: this.isoNow(),
        error: null,
        sizeMb: fileSizeMb,
        bytesDone: totalBytes,
        bytesTotal: totalBytes,
        heartbeatAt: this.isoNow(),
      });
      await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);

      await job.updateProgress(100);

      this.logger.log({
        message: 'AiModel published to the models bucket',
        jobId,
        aiModelId,
        attempt,
        sourceUri: model.sourceUri,
        bucketPrefix: prefix,
        localPath,
        fileSizeMb,
      });

      return { aiModelId, sourceUri: model.sourceUri, bucketPrefix: prefix, localPath, fileSizeMb, sha256: primarySha256 };
    } catch (error) {
      await heartbeat?.stop();
      const message = error instanceof Error ? error.message : String(error);
      const recordFailure = finalAttempt || isNonRetryable(error);
      this.logger.error({ message: 'AiModel publish failed', jobId, aiModelId, attempt, willRetry: !recordFailure, error: message });

      const fresh = await this.aiModelRepository.findById(aiModelId).catch(() => null);
      if (fresh) {
        // The failure is recorded in the run bookkeeping; `availability` is
        // deliberately NOT re-measured. A failed re-publish does not remove
        // the weights a previous run staged, and claiming MISSING here would
        // make a working row unusable on the strength of a network error.
        // With attempts left the row stays DOWNLOADING for the retry.
        if (userId) fresh.updatedBy = userId;
        fresh.metaData = recordFailure
          ? mergeDownloadMeta(fresh.metaData, { jobId, finishedAt: this.isoNow(), error: message, heartbeatAt: this.isoNow() })
          : mergeDownloadMeta(fresh.metaData, { jobId, finishedAt: null, error: null, heartbeatAt: this.isoNow() });
        await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);
      }

      throw this.toJobError(error, finalAttempt, { jobId, aiModelId, action: 'download' });
    } finally {
      await removeStagingDir(stagingDir);
    }
  }

  /**
   * One heartbeat write: re-read the row and merge progress into THIS job's
   * bookkeeping. Skipped when the row has moved on (another job, or this one
   * already finished); an OCC clash is dropped — the next beat retries.
   */
  private async writeHeartbeat(aiModelId: string, jobId: string, snapshot: DownloadHeartbeatSnapshot): Promise<void> {
    const fresh = await this.aiModelRepository.findById(aiModelId);
    const meta = readDownloadMeta(fresh?.metaData);
    if (!fresh || meta?.jobId !== jobId || meta.finishedAt || meta.error) return;
    fresh.metaData = mergeDownloadMeta(fresh.metaData, { bytesDone: snapshot.bytesDone, bytesTotal: snapshot.bytesTotal, heartbeatAt: snapshot.heartbeatAt });
    try {
      await this.aiModelRepository.updateWithVersion(aiModelId, fresh, fresh.version);
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException) return;
      throw error;
    }
  }

  /**
   * A coded failure no retry can fix is thrown as `UnrecoverableError`, so
   * BullMQ does not spend the remaining attempts on it; everything else is
   * rethrown as-is (BullMQ retries it while attempts remain).
   */
  private toJobError(error: unknown, finalAttempt: boolean, context: Record<string, string>): unknown {
    if (!finalAttempt && isNonRetryable(error)) {
      this.logger.warn({ message: 'Publisher job failed with a non-retryable code', ...context, code: (error as ModelPublisherError).code });
      return new UnrecoverableError((error as Error).message);
    }
    return error;
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * For a Hub-sourced row: the commit sha of `revision` (the row's pinned
   * `sourceRevision`, else `main`) and the two prefixes of its HF-cache layout.
   * `null` for a non-Hub source, and for a Hub the job could not reach (the
   * caller then fetches `main`, publishes flat and records no revision).
   */
  private async resolveHubInfo(sourceUri: string, revision: string | null): Promise<{ sha: string; repoPrefix: string; snapshotPrefix: string } | null> {
    const match = sourceUri.match(HF_REPO_RE);
    if (!match) return null;
    const [, org, repo] = match;
    try {
      const info = await this.hfClient.getRepoInfo(`${org}/${repo}`, revision || 'main');
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

function isNonRetryable(error: unknown): boolean {
  return error instanceof ModelPublisherError && NON_RETRYABLE_PUBLISHER_CODES.has(error.code);
}
