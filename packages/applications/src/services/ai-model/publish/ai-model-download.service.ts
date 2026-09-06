import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { uuidv7 } from 'uuidv7';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { AiModelRepository, JobQueue, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { derivePublishStatus, mergeDownloadMeta, readDownloadMeta } from './model-download-meta.util';
import { derivedLocalPath } from '../constants';
import { ModelDownloadStatusResponse, TriggerModelDownloadResponse } from './dto';
import type { DownloadAiModelJobPayload } from './ai-model-download.processor';

/**
 * AiModelDownloadService — the trigger + status-poll half of the model
 * download/publish action. Mirrors `DirectorySyncService`:
 * a thin admin-triggered enqueue in front of a BullMQ processor
 * (`AiModelDownloadProcessor`) that does the actual fetch/verify/publish
 * work, kept OUT of the request path.
 *
 * Deliberately a SEPARATE service from `AiModelService` (not new methods on
 * it) — same split as `TenantIdentityProviderService` /
 * `DirectorySyncService`: CRUD stays CRUD, an admin-triggered async action
 * gets its own bounded surface.
 */
@Injectable()
export class AiModelDownloadService extends BaseService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    @InjectQueue(JobQueue.DownloadAiModel) private readonly downloadQueue: Queue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  /**
   * Trigger an async download of `id`'s weights into the `hope-models`
   * bucket.
   *
   * The DOWNLOADING transition is written HERE, synchronously, via
   * `updateWithVersion` — not left for the worker to set once it picks the
   * job up. That closes the race a rapid double-POST would otherwise open
   * (the job might not have started running yet when the second request's
   * status check runs). Two outcomes both surface as `409 Conflict`, which is
   * what the frozen contract asks for: an already-DOWNLOADING row (checked
   * up front) and a genuine CAS race between two concurrent triggers (caught
   * from `OptimisticConcurrencyException`, which would otherwise be a
   * `412 Precondition Failed` — the client never supplied an `If-Match` here,
   * so 412's "you are stale, refetch" framing does not apply).
   */
  async triggerDownload(id: string): Promise<TriggerModelDownloadResponse> {
    const userId = this.requestUserId;

    const existing = await this.aiModelRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Model ${id} not found`);
    }
    // TASK-890 §3.11 — the in-flight test is the run bookkeeping, not the dropped
    // `downloadStatus` column. Same guard, same 409, one fewer column.
    if (derivePublishStatus(readDownloadMeta(existing.metaData), existing.availability) === 'DOWNLOADING') {
      throw new ConflictException(`A download for model ${id} is already in progress`);
    }

    const jobId = uuidv7();
    const expectedVersion = existing.version;
    const startedAt = new Date().toISOString();

    // The CLAIM is the bookkeeping write itself: it changes the row, so the CAS
    // below still closes the double-POST race exactly as the status write did.
    existing.metaData = mergeDownloadMeta(existing.metaData, { jobId, startedAt, finishedAt: null, error: null, sizeMb: null });
    if (userId) existing.updatedBy = userId;

    let updated;
    try {
      updated = await this.aiModelRepository.updateWithVersion(id, existing, expectedVersion);
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException) {
        throw new ConflictException(`A download for model ${id} is already in progress`);
      }
      throw error;
    }

    const payload: DownloadAiModelJobPayload = { jobId, aiModelId: id, tenantId: updated.tenantId, userId: userId ?? undefined };
    await this.downloadQueue.add(JobQueue.DownloadAiModel, payload, { jobId, attempts: 1 });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { publishStatus: 'DOWNLOADING', jobId },
    });

    return { jobId, status: 'DOWNLOADING' };
  }

  /** Poll the most recent download job's status for `id`. */
  async getDownloadStatus(id: string): Promise<ModelDownloadStatusResponse> {
    const existing = await this.aiModelRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Model ${id} not found`);
    }

    const meta = readDownloadMeta(existing.metaData);

    return {
      status: derivePublishStatus(meta, existing.availability),
      startedAt: meta?.startedAt ? new Date(meta.startedAt) : null,
      finishedAt: meta?.finishedAt ? new Date(meta.finishedAt) : null,
      fileSizeMb: meta?.sizeMb ?? null,
      sha256: existing.checksum ?? null,
      localPath: derivedLocalPath(existing),
      error: meta?.error ?? null,
    };
  }
}
