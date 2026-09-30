import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { AiModelEntity, AiModelRepository, JobQueue, ResourceStatusType, ResourceType, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import type { PublisherJobState } from '@arcaai/types';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { assertPlatformRegistryAdmin } from '../lifecycle/platform-admin';
import { effectiveStaleAfterMs, readModelDownloadSettings, type DownloadSettingsSource } from '../lifecycle/model-download-settings';
import { publishStatusOf } from '../lifecycle/model-lifecycle.derive';
import { CancelModelDownloadRequest, CancelModelDownloadResponse, PublisherJobView } from './dto';
import { DOWNLOAD_CANCELLED_CODE, isUnregisterStale, mergeDownloadMeta, readDownloadMeta, readUnregisterMeta } from './model-download-meta.util';
import { DOWNLOAD_STALLED_CODE, isUnregisterJob, type PublisherJobPayload } from './publisher-job.contract';
import { PUBLISHER_CANCEL_FLAGS, type PublisherCancelFlags } from './publisher-cancel-flags';

/** BullMQ states in which a job has not started: it can simply be removed. */
const QUEUED_STATES: ReadonlySet<string> = new Set(['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children']);

/** The code a cancel on a download that is not running answers with (409). */
export const JOB_NOT_ACTIVE = 'JOB_NOT_ACTIVE';

/** `GET jobs` page size: default and ceiling. */
export const PUBLISHER_JOBS_DEFAULT_LIMIT = 50;
export const PUBLISHER_JOBS_MAX_LIMIT = 200;

/** BullMQ state buckets read for the list, and the view state each maps to. */
const LIST_BUCKETS: ReadonlyArray<{ types: string[]; state: PublisherJobState }> = [
  { types: ['active'], state: 'active' },
  { types: ['waiting', 'delayed', 'prioritized', 'paused'], state: 'waiting' },
  { types: ['completed'], state: 'completed' },
  { types: ['failed'], state: 'failed' },
];

const iso = (ms: number | undefined | null): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** How often an OCC clash with the worker's heartbeat is re-read and retried on the cancel write. */
const CANCEL_WRITE_ATTEMPTS = 3;

/**
 * ModelPublisherJobsService — the gateway half of download-job CONTROL
 * (TASK-1023 D-C): cancel a download, list the publisher's recent jobs.
 *
 * Platform administration, like every other registry operation: each method
 * asserts a SUPER_ADMIN in a tenant-less context FIRST (row-independent).
 *
 * Cancel has two shapes, decided by where the job is:
 *   QUEUED (or lost by BullMQ)  the job is removed and the run is recorded
 *                               CANCELLED now — nothing ever ran;
 *   ACTIVE                      a cooperative cancel: the Redis flag
 *                               `model-publisher:cancel:<jobId>` tells the
 *                               worker to abort, clean up and record CANCELLED
 *                               itself; the gateway records only the request.
 */
@Injectable()
export class ModelPublisherJobsService extends BaseService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    @InjectQueue(JobQueue.DownloadAiModel) private readonly publisherQueue: Queue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject(PUBLISHER_CANCEL_FLAGS) private readonly cancelFlags: PublisherCancelFlags,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: DownloadSettingsSource,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  async cancelDownload(id: string, request: CancelModelDownloadRequest = {}): Promise<CancelModelDownloadResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'cancel a model download');
    const settings = readModelDownloadSettings(this.appSettings);
    const row = await this.findRow(id);

    const meta = readDownloadMeta(row.metaData);
    if (!meta || publishStatusOf(row, { now: Date.now(), staleAfterMs: effectiveStaleAfterMs(settings) }) !== 'DOWNLOADING') {
      throw this.notActive(row);
    }
    const jobId = meta.jobId;
    const removeRegistration = request.removeRegistration === true;

    // Idempotent: the worker is already stopping this run. Re-asserting the flag
    // is harmless and heals a flag whose TTL ran out.
    if (meta.cancelRequestedAt) {
      await this.cancelFlags.request(jobId);
      if (removeRegistration && !meta.removeRegistrationOnCancel) {
        await this.writeRun(row.id, jobId, { removeRegistrationOnCancel: true });
      }
      return { jobId, outcome: 'cancelling', unregisterJobId: null };
    }

    const job = (await this.publisherQueue.getJob(jobId)) as Job | undefined | null;
    const state = job ? await job.getState() : 'missing';

    if (state === 'missing' || QUEUED_STATES.has(state)) {
      const removed = await this.tryRemove(job ?? null);
      if (removed) return this.cancelQueued(row, jobId, removeRegistration);
      // It turned active between the state read and the remove: stop it cooperatively.
    } else if (state !== 'active') {
      // completed / failed / unknown: the worker is about to (or already did)
      // record the outcome — there is nothing left to cancel.
      throw this.notActive(row);
    }

    await this.cancelFlags.request(jobId);
    const now = new Date().toISOString();
    await this.writeRun(row.id, jobId, {
      cancelRequestedAt: now,
      cancelRequestedBy: this.requestUserId ?? null,
      ...(removeRegistration ? { removeRegistrationOnCancel: true } : {}),
    });
    this.broadcastSysEvent(SysEventType.ResourceUpdated, { resourceId: row.id, data: { action: 'download.cancel', jobId, outcome: 'cancelling' } });
    return { jobId, outcome: 'cancelling', unregisterJobId: null };
  }

  /**
   * Recent publisher jobs, newest first (D-C): every job BullMQ still holds,
   * overlaid with the row bookkeeping of the run it names, PLUS every run the
   * bookkeeping shows that BullMQ no longer holds — a queued job removed by a
   * cancel, or an in-flight one whose job was lost — so nothing the grid
   * reports as moving is missing here.
   */
  async listJobs(limit?: number): Promise<PublisherJobView[]> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'list model-publisher jobs');
    const cap = Math.min(Math.max(Math.floor(limit ?? PUBLISHER_JOBS_DEFAULT_LIMIT), 1), PUBLISHER_JOBS_MAX_LIMIT);
    const staleAfterMs = effectiveStaleAfterMs(readModelDownloadSettings(this.appSettings));
    const now = Date.now();

    const bull: Array<{ job: Job<PublisherJobPayload>; state: PublisherJobState }> = [];
    for (const bucket of LIST_BUCKETS) {
      const jobs = ((await this.publisherQueue.getJobs(bucket.types as never, 0, cap - 1, false)) ?? []) as Job<PublisherJobPayload>[];
      for (const job of jobs) if (job?.data?.aiModelId) bull.push({ job, state: bucket.state });
    }

    const rows = new Map<string, AiModelEntity>();
    for (const row of await this.aiModelRepository.findAll({ filters: { tenantId: SYSTEM_TENANT_ID } } as never)) rows.set(row.id, row);
    const missing = [...new Set(bull.map((b) => b.job.data.aiModelId))].filter((id) => !rows.has(id));
    if (missing.length > 0) {
      // Unregistered rows are soft-deleted; read them back by id so their jobs still name the model.
      const deleted = await this.aiModelRepository.findAll({ filters: { id: { in: missing }, resourceStatus: ResourceStatusType.DELETED } } as never);
      for (const row of deleted) rows.set(row.id, row);
    }

    const views: PublisherJobView[] = [];
    const seen = new Set<string>();
    for (const { job, state } of bull) {
      const jobId = String(job.data.jobId ?? job.id);
      if (seen.has(jobId)) continue;
      seen.add(jobId);
      views.push(this.viewOfBullJob(job, jobId, state, rows.get(job.data.aiModelId) ?? null));
    }
    for (const row of rows.values()) {
      views.push(...this.viewsOfLostRuns(row, seen, { now, staleAfterMs }));
    }

    return views.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, cap);
  }

  private viewOfBullJob(job: Job<PublisherJobPayload>, jobId: string, bullState: PublisherJobState, row: AiModelEntity | null): PublisherJobView {
    const payload = job.data;
    const base = this.baseView(jobId, isUnregisterJob(payload) ? 'unregister' : 'download', payload.aiModelId, row, payload.userId ?? null);
    let state = bullState;
    let startedAt = iso(job.timestamp) ?? new Date(0).toISOString();
    let finishedAt = iso(job.finishedOn);
    let error: PublisherJobView['error'] = bullState === 'failed' ? { code: 'FAILED', message: job.failedReason ?? 'failed' } : null;

    if (base.kind === 'download') {
      const meta = readDownloadMeta(row?.metaData ?? null);
      if (meta?.jobId === jobId) {
        base.bytesDone = meta.bytesDone ?? null;
        base.bytesTotal = meta.bytesTotal ?? null;
        startedAt = meta.startedAt ?? startedAt;
        finishedAt = finishedAt ?? meta.finishedAt;
        if (meta.cancelledAt) {
          state = 'cancelled';
          error = { code: DOWNLOAD_CANCELLED_CODE, message: 'Cancelled by an administrator.' };
        }
      }
      if ((job.returnvalue as { superseded?: boolean } | undefined)?.superseded) {
        error = { code: 'SUPERSEDED', message: 'A newer download of this model replaced this job.' };
      }
    } else {
      const meta = readUnregisterMeta(row?.metaData ?? null);
      if (meta?.jobId === jobId) {
        startedAt = meta.startedAt;
        finishedAt = finishedAt ?? meta.finishedAt;
        if (meta.error && bullState === 'failed') error = { code: 'FAILED', message: meta.error };
      }
    }
    return { ...base, state, startedAt, finishedAt, error };
  }

  /** Runs the row's bookkeeping names that BullMQ does not hold (removed by a cancel, or lost). */
  private viewsOfLostRuns(row: AiModelEntity, seen: Set<string>, opts: { now: number; staleAfterMs: number }): PublisherJobView[] {
    const views: PublisherJobView[] = [];
    const download = readDownloadMeta(row.metaData);
    if (download?.jobId && download.startedAt && !seen.has(download.jobId)) {
      const status = publishStatusOf(row, opts);
      // The bookkeeping does not record who STARTED a run; BullMQ's payload did, and it is gone.
      const base = this.baseView(download.jobId, 'download', row.id, row, null);
      base.bytesDone = download.bytesDone ?? null;
      base.bytesTotal = download.bytesTotal ?? null;
      const view = { ...base, startedAt: download.startedAt, finishedAt: download.finishedAt };
      if (status === 'CANCELLED') {
        views.push({ ...view, state: 'cancelled', error: { code: DOWNLOAD_CANCELLED_CODE, message: 'Cancelled by an administrator.' } });
      } else if (status === 'DOWNLOADING') {
        views.push({ ...view, state: download.attempt != null ? 'active' : 'waiting', error: null });
      } else if (!download.finishedAt && !download.error) {
        views.push({ ...view, state: 'failed', error: { code: DOWNLOAD_STALLED_CODE, message: 'No heartbeat within the stale window; the job was lost.' } });
      }
    }
    const unregister = readUnregisterMeta(row.metaData);
    if (unregister && !unregister.finishedAt && !unregister.error && !seen.has(unregister.jobId)) {
      const stale = isUnregisterStale(unregister, { now: new Date(opts.now), staleAfterMs: opts.staleAfterMs });
      views.push({
        ...this.baseView(unregister.jobId, 'unregister', row.id, row, null),
        state: stale ? 'failed' : 'waiting',
        startedAt: unregister.startedAt,
        finishedAt: null,
        error: stale ? { code: 'UNREGISTER_FAILED', message: 'The unregister job was lost; retry it.' } : null,
      });
    }
    return views;
  }

  private baseView(jobId: string, kind: 'download' | 'unregister', aiModelId: string, row: AiModelEntity | null, startedBy: string | null) {
    return {
      jobId,
      kind,
      aiModelId,
      modelSlug: row?.slug ?? '',
      modelName: (row as { name?: string } | null)?.name ?? row?.slug ?? '',
      bytesDone: null as number | null,
      bytesTotal: null as number | null,
      startedBy,
    };
  }

  /** A queued job is gone: the run is CANCELLED now (nothing ran, nothing to clean). */
  private async cancelQueued(row: AiModelEntity, jobId: string, removeRegistration: boolean): Promise<CancelModelDownloadResponse> {
    const now = new Date().toISOString();
    await this.writeRun(row.id, jobId, {
      finishedAt: now,
      error: DOWNLOAD_CANCELLED_CODE,
      cancelledAt: now,
      cancelledBy: this.requestUserId ?? null,
      heartbeatAt: now,
    });
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: row.id,
      data: { action: 'download.cancel', jobId, outcome: 'removed', publishStatus: 'CANCELLED' },
    });
    const unregisterJobId = removeRegistration ? await this.unregisterAfterCancel(row.id) : null;
    return { jobId, outcome: 'removed', unregisterJobId };
  }

  /** J4 — filled in with the unregister flow. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async unregisterAfterCancel(_id: string): Promise<string | null> {
    return null;
  }

  /** `job.remove()`; `false` when BullMQ refuses because a worker holds the job's lock. */
  private async tryRemove(job: Job | null): Promise<boolean> {
    if (!job) return true;
    try {
      await job.remove();
      return true;
    } catch {
      // swallow-ok: a locked job is ACTIVE — the caller falls back to the cooperative cancel.
      return false;
    }
  }

  /**
   * Merge `update` into THIS run's bookkeeping, re-reading on an OCC clash (the
   * worker's heartbeat writes the same row). A row whose run moved on is left alone.
   */
  private async writeRun(id: string, jobId: string, update: Parameters<typeof mergeDownloadMeta>[1]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const fresh = await this.findRow(id);
      if (readDownloadMeta(fresh.metaData)?.jobId !== jobId) return;
      fresh.metaData = mergeDownloadMeta(fresh.metaData, { jobId, ...update });
      if (this.requestUserId) fresh.updatedBy = this.requestUserId;
      try {
        await this.aiModelRepository.updateWithVersion(id, fresh, fresh.version);
        return;
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyException) || attempt >= CANCEL_WRITE_ATTEMPTS) {
          if (error instanceof OptimisticConcurrencyException) {
            throw new ConflictException({ code: 'MODEL_CHANGED', message: `Model ${id} changed while its download was being cancelled; try again.` });
          }
          throw error;
        }
      }
    }
  }

  private notActive(row: AiModelEntity): ConflictException {
    return new ConflictException({ code: JOB_NOT_ACTIVE, message: `Model '${row.slug}' has no download in progress to cancel.` });
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
