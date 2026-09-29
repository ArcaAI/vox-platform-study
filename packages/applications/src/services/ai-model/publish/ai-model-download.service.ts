import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { uuidv7 } from 'uuidv7';
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { AiModelEntity, AiModelRepository, AiModelSource, JobQueue, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { mergeDownloadMeta, readDownloadMeta } from './model-download-meta.util';
import { derivedLocalPath } from '../constants';
import { ModelDownloadStatusResponse, TriggerModelDownloadResponse } from './dto';
import type { DownloadAiModelJobPayload, PublisherJobPayload } from './publisher-job.contract';
import { DOWNLOAD_STALLED_CODE } from './publisher-job.contract';
import { assertPlatformRegistryAdmin } from '../lifecycle/platform-admin';
import { MODEL_DOWNLOAD_BACKOFF_DELAY_MS, readModelDownloadSettings, type DownloadSettingsSource } from '../lifecycle/model-download-settings';
import { isUnregistering, publishStatusOf } from '../lifecycle/model-lifecycle.derive';

/** The queue surface the producer needs — `add` only. */
export type PublisherQueue = Pick<Queue, 'add'>;

/**
 * Enqueue one publisher job with the platform's retry policy (D-4): BullMQ
 * `attempts` from `modelRegistry.download.maxAttempts`, exponential backoff.
 * The job id IS the bookkeeping id, so a poll can name the run it reports.
 */
export async function enqueuePublisherJob(queue: PublisherQueue, payload: PublisherJobPayload, maxAttempts: number): Promise<void> {
  await queue.add(JobQueue.DownloadAiModel, payload, {
    jobId: payload.jobId,
    attempts: maxAttempts,
    backoff: { type: 'exponential', delay: MODEL_DOWNLOAD_BACKOFF_DELAY_MS },
  });
}

/**
 * CLAIM a registry row for a download, then enqueue it — the ONE producer path
 * behind `POST :id/download`, `POST register-from-hub` and `POST download-missing`.
 *
 * The DOWNLOADING transition is written HERE, synchronously, via
 * `updateWithVersion` — not left for the worker to set once it picks the job
 * up. That closes the race a rapid double-POST would otherwise open. A CAS race
 * surfaces as `409` (the client sent no `If-Match`, so 412's "refetch" framing
 * does not apply). `heartbeatAt` starts at the claim, so a job no worker ever
 * picks up goes STALLED after `staleAfterSeconds` instead of reading DOWNLOADING
 * forever.
 */
export async function claimAndEnqueueDownload(
  deps: { repository: Pick<AiModelRepository, 'updateWithVersion'>; queue: PublisherQueue },
  entity: AiModelEntity,
  opts: { userId?: string | null; maxAttempts: number; now?: Date },
): Promise<{ jobId: string; updated: AiModelEntity }> {
  const jobId = uuidv7();
  const startedAt = (opts.now ?? new Date()).toISOString();
  const expectedVersion = entity.version;

  const merged = mergeDownloadMeta(entity.metaData, { jobId, startedAt, finishedAt: null, error: null, sizeMb: null });
  entity.metaData = {
    ...merged,
    download: { ...(merged.download as Record<string, unknown>), bytesDone: null, bytesTotal: null, heartbeatAt: startedAt, attempt: null },
  };
  if (opts.userId) entity.updatedBy = opts.userId;

  let updated: AiModelEntity;
  try {
    updated = await deps.repository.updateWithVersion(entity.id, entity, expectedVersion);
  } catch (error) {
    if (error instanceof OptimisticConcurrencyException) {
      throw new ConflictException(`A download for model ${entity.id} is already in progress`);
    }
    throw error;
  }

  const payload: DownloadAiModelJobPayload = {
    kind: 'download',
    jobId,
    aiModelId: entity.id,
    tenantId: updated.tenantId,
    userId: opts.userId ?? undefined,
  };
  await enqueuePublisherJob(deps.queue, payload, opts.maxAttempts);
  return { jobId, updated };
}

/**
 * AiModelDownloadService — the trigger + status-poll half of the model
 * download/publish action. A thin admin-triggered enqueue in front of the
 * model-publisher worker, which does the actual fetch/verify/publish work
 * OUTSIDE the gateway (TASK-1019 OD-1).
 *
 * Platform administration end to end (D-11): every method asserts a SUPER_ADMIN
 * in a tenant-less context first — the controller's `manage:all` guard alone
 * used to be the only gate on both routes.
 */
@Injectable()
export class AiModelDownloadService extends BaseService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    @InjectQueue(JobQueue.DownloadAiModel) private readonly downloadQueue: Queue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-1019 D-4 — `@Optional()` and TRAILING so positional fixtures keep their
    // arity; absent, both knobs fall back to their descriptor defaults.
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: DownloadSettingsSource,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  /**
   * Trigger an async download of `id`'s weights into the `hope-models` bucket.
   *
   * Refused with 409 while a download is in flight or the model is being
   * unregistered. A DOWNLOADING row whose heartbeat went stale derives as
   * DOWNLOAD_FAILED (STALLED) and may be re-triggered.
   */
  async triggerDownload(id: string): Promise<TriggerModelDownloadResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'download model weights');
    const userId = this.requestUserId;
    const settings = readModelDownloadSettings(this.appSettings);

    const existing = await this.findRow(id);
    // TASK-960 D1 — a LOCAL row's weights are expected already staged under
    // the `hope-models` bucket mount; there is nothing to download. Refused
    // BEFORE the in-flight check and before any write.
    if (existing.source === AiModelSource.LOCAL) {
      throw new ConflictException(
        `Model ${id} has source LOCAL — its weights are expected already staged under the hope-models bucket mount, so there is nothing to download. Set 'bucketPrefix' (and 'primaryObject' for a single-file loader) to register the already-staged files instead.`,
      );
    }
    if (isUnregistering(existing.metaData)) {
      throw new ConflictException(`Model ${id} is being unregistered`);
    }
    if (publishStatusOf(existing, { now: Date.now(), staleAfterMs: settings.staleAfterMs }) === 'DOWNLOADING') {
      throw new ConflictException(`A download for model ${id} is already in progress`);
    }

    const { jobId, updated } = await claimAndEnqueueDownload({ repository: this.aiModelRepository, queue: this.downloadQueue }, existing, {
      userId,
      maxAttempts: settings.maxAttempts,
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { publishStatus: 'DOWNLOADING', jobId },
    });

    return { jobId, status: 'DOWNLOADING' };
  }

  /** Poll the most recent download job's status for `id`. */
  async getDownloadStatus(id: string): Promise<ModelDownloadStatusResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'read a model download');
    const existing = await this.findRow(id);
    const { staleAfterMs } = readModelDownloadSettings(this.appSettings);

    const meta = readDownloadMeta(existing.metaData);
    const status = publishStatusOf(existing, { now: Date.now(), staleAfterMs });

    return {
      status,
      startedAt: meta?.startedAt ? new Date(meta.startedAt) : null,
      finishedAt: meta?.finishedAt ? new Date(meta.finishedAt) : null,
      fileSizeMb: meta?.sizeMb ?? null,
      sha256: existing.checksum ?? null,
      localPath: derivedLocalPath(existing),
      error: meta?.error ?? (status === 'DOWNLOAD_FAILED' ? DOWNLOAD_STALLED_CODE : null),
    };
  }

  private async findRow(id: string): Promise<AiModelEntity> {
    const existing = await this.aiModelRepository.findById(id).catch((error: unknown) => {
      if (error instanceof DataNotFoundException) return null;
      throw error;
    });
    if (!existing) throw new NotFoundException(`Model ${id} not found`);
    return existing;
  }
}
