import { Inject, Injectable, Logger, MessageEvent, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
import { uuidv7 } from 'uuidv7';
import { JobQueue } from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { GeneratePreSummaryJobPayload, ConsultationJobStatus, JobResponse, JobStatusResponse } from './dto';
import { JobIdempotencyService } from './job-idempotency.service';
import type { IdempotencyScope } from './job-idempotency.service';

/** Terminal job statuses. `CANCELED` is accepted as an alias of `CANCELLED` on read (G14). */
const TERMINAL_JOB_STATUSES = new Set<string>(['COMPLETED', 'FAILED', 'CANCELLED', 'CANCELED']);
/** G10 — an idle job stream sends an SSE comment this often, so a proxy never reaps it. */
export const CONSULTATION_JOB_STREAM_KEEPALIVE_MS = 15_000;

export function isTerminalJobStatus(status: string | undefined | null): boolean {
  return typeof status === 'string' && TERMINAL_JOB_STATUSES.has(status);
}

/** The stream route a job's updates are read from (G16 — the old `/api/consultations/jobs/:id/sse` did not exist). */
export function consultationJobStreamUrl(jobId: string): string {
  return `/api/v1/consultations/jobs/${encodeURIComponent(jobId)}/stream`;
}

// `createSummaryJob`/`createNerJob` (the legacy `SUMMARY_REGENERATE`
// async generator and its NER companion) were deleted here along with
// `summary.processor.ts`/`ner.processor.ts`. `generateSummaryAsync` now calls
// `NoteGenerationService.generate(GenerationTrigger.SUMMARY_REGENERATE, …)`
// directly (see `apps/api/.../consultation.controller.ts`); auto-NER's
// duplicate-work skip collapsed to unconditional in `consultation-event.handler.ts`.
export interface IConsultationJobService {
  createPreSummaryJob(
    consultationId: string,
    tenantId: string,
    userId: string,
    request: GeneratePreSummaryJobPayload['request'],
    callbackUrl?: string,
    /** Redis-backed dedupe key for the POST creation. */
    idempotencyKey?: string,
  ): Promise<JobResponse>;

  /**
   * Publish the status record for a note-generation run the HARNESS owns.
   *
   * The harness seam mints its own correlation id (`harness-doc-<uuid>` in
   * `NoteGenerationService.generate`) and dispatches straight to
   * apps/harness — it never enqueues onto BullMQ, so none of the `create*Job`
   * methods above ever run for it. Without this record `GET
   * /consultations/jobs/:jobId` (and `/cancel`, `/stream`) resolve nothing:
   * `TenantOwnedResourceInterceptor` reads `getJobStatus` for its tenancy
   * check and 404s first. removed the legacy queue path that used to
   * write it; this restores the endpoint's contract that the returned jobId is
   * resolvable by its creator.
   */
  registerHarnessNoteJob(jobId: string, consultationId: string, tenantId: string, userId: string): Promise<void>;

  /**
   * TASK-1038 B3a — run a job START at most once per `Idempotency-Key` (same key + same body ⇒
   * the same answer; a different body ⇒ 409). See `JobIdempotencyService`.
   */
  runIdempotent<T>(scope: IdempotencyScope, fingerprintInput: unknown, create: () => Promise<T>): Promise<{ value: T; replayed: boolean }>;

  getJobStatus(jobId: string): Promise<JobStatusResponse | null>;
  cancelJob(jobId: string): Promise<boolean>;
  subscribeToJobUpdates(jobId: string): Observable<MessageEvent>;
  notifyProgress(jobId: string, progress: number, currentStep: string): Promise<void>;
  notifyComplete(jobId: string, result: unknown): Promise<void>;
  notifyFailed(jobId: string, error: string): Promise<void>;
}

export const IConsultationJobService = Symbol('IConsultationJobService');

@Injectable()
export class ConsultationJobService implements IConsultationJobService {
  private readonly logger = new Logger(ConsultationJobService.name);
  private readonly JOB_TTL = 86400; // 24 hours
  private readonly JOB_KEY_PREFIX = 'consultation_job:';
  private readonly JOB_CHANNEL_PREFIX = 'consultation_job_updates:';
  // Idempotency-Key dedupe lives in `JobIdempotencyService` (TASK-1038 B3a); its key namespace
  // is still scoped by operation + tenantId + userId so two doctors (or two tenants) cannot
  // collide on the same key and leak each other's jobIds.

  constructor(
    @InjectQueue(JobQueue.GeneratePreSummary) private preSummaryQueue: Queue,
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
    // TASK-1038 B3a (G14) — a SUMMARY job is a harness document run; cancelling it asks the
    // harness to cancel that workflow. Optional + trailing: absent ⇒ SUMMARY stays uncancellable.
    @Optional() private readonly harnessGateway?: HarnessGatewayService,
  ) {
    this.idempotency = new JobIdempotencyService(cacheService);
    this.logger.log('ConsultationJobService initialized');
  }

  private readonly idempotency: JobIdempotencyService;

  runIdempotent<T>(scope: IdempotencyScope, fingerprintInput: unknown, create: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    return this.idempotency.run(scope, fingerprintInput, create);
  }

  /**
   * Create a pre-summary generation job
   */
  async createPreSummaryJob(
    consultationId: string,
    tenantId: string,
    userId: string,
    request: GeneratePreSummaryJobPayload['request'],
    callbackUrl?: string,
    idempotencyKey?: string,
  ): Promise<JobResponse> {
    // TASK-1038 B3a — `Idempotency-Key`: the same key with the same request is the same job;
    // a different request under the same key is a 409. A pre-TASK-1038 record (a bare job id)
    // still replays that job.
    const { value: jobId } = await this.idempotency.run(
      { operation: 'pre-summary', tenantId, principalId: userId, key: idempotencyKey },
      { consultationId, request, callbackUrl: callbackUrl ?? null },
      () => this.enqueuePreSummaryJob(consultationId, tenantId, userId, request, callbackUrl),
      (legacyJobId) => legacyJobId,
    );
    return { jobId, status: 'PENDING', sseUrl: consultationJobStreamUrl(jobId), estimatedSeconds: 30 };
  }

  private async enqueuePreSummaryJob(
    consultationId: string,
    tenantId: string,
    userId: string,
    request: GeneratePreSummaryJobPayload['request'],
    callbackUrl?: string,
  ): Promise<string> {
    const jobId = uuidv7();

    const payload: GeneratePreSummaryJobPayload = {
      jobId,
      consultationId,
      tenantId,
      userId,
      request,
      callbackUrl,
    };

    await this.preSummaryQueue.add('generate', payload, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 }, // Keep completed jobs for 1 hour
      removeOnFail: { age: 86400 }, // Keep failed jobs for 24 hours
    });

    await this.storeJobStatus(jobId, {
      jobId,
      type: 'PRE_SUMMARY',
      status: 'PENDING',
      consultationId,
      progress: 0,
      createdAt: new Date(),
      tenantId,
      userId,
    });

    this.logger.log({
      message: 'Created pre-summary job',
      jobId,
      consultationId,
      tenantId,
    });
    return jobId;
  }

  /**
   * Publish the status record for a harness-owned note-generation run.
   * See the interface declaration for why this exists.
   */
  async registerHarnessNoteJob(jobId: string, consultationId: string, tenantId: string, userId: string): Promise<void> {
    await this.storeJobStatus(jobId, {
      jobId,
      type: 'SUMMARY',
      status: 'PENDING',
      consultationId,
      progress: 0,
      createdAt: new Date(),
      tenantId,
      userId,
    });

    this.logger.log({
      message: 'Registered harness note-generation job',
      jobId,
      consultationId,
      tenantId,
    });
  }

  /**
   * Get job status from Redis
   */
  async getJobStatus(jobId: string): Promise<JobStatusResponse | null> {
    const data = await this.cacheService.get(`${this.JOB_KEY_PREFIX}${jobId}`);
    if (!data) return null;

    const status = JSON.parse(data) as ConsultationJobStatus;
    return {
      ...status,
      // G14 — the interpreter's spelling `CANCELED` reads as the job vocabulary's `CANCELLED`.
      status: (status.status as string) === 'CANCELED' ? 'CANCELLED' : status.status,
      createdAt: new Date(status.createdAt),
      startedAt: status.startedAt ? new Date(status.startedAt) : undefined,
      completedAt: status.completedAt ? new Date(status.completedAt) : undefined,
    };
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const status = await this.getJobStatus(jobId);
    if (!status) return false;

    // Can't cancel a terminal job (either spelling — G14).
    if (isTerminalJobStatus(status.status)) {
      return false;
    }

    switch (status.type) {
      case 'PRE_SUMMARY': {
        const job = await this.preSummaryQueue.getJob(jobId);
        if (job) {
          const state = await job.getState();
          if (state === 'waiting' || state === 'delayed') {
            await job.remove();
          }
        }
        break;
      }
      case 'SUMMARY': {
        // TASK-1038 B3a (G14) — a SUMMARY job is the consultation's harness DOCUMENT workflow
        // (`NoteGenerationService`), which the harness can cancel (cooperatively). No harness, no
        // consultation, or a refusal ⇒ not cancellable, never a fake CANCELLED.
        if (!this.harnessGateway || !status.consultationId) return false;
        try {
          await this.harnessGateway.cancelDocumentWorkflow(status.consultationId, { tenantId: status.tenantId, reason: `consultation job ${jobId} cancelled` });
        } catch (err) {
          this.logger.warn({ message: 'Harness refused to cancel the summary job', jobId, error: err instanceof Error ? err.message : String(err) });
          return false;
        }
        break;
      }
      // 'NER' job types can no longer be cancelled here: their queue and processor were deleted
      // along with `createNerJob`. A stale status row of that type falls through (not found).
      // 'COMPREHENSIVE_SUMMARY' likewise (TASK-1006): no job of this type is ever created.
      default:
        return false;
    }

    // Update status
    await this.updateJobStatus(jobId, {
      status: 'CANCELLED',
      completedAt: new Date(),
    });

    this.logger.log({
      message: 'Cancelled job',
      jobId,
      type: status.type,
    });

    return true;
  }

  /**
   * Subscribe to real-time job updates via Redis Pub/Sub.
   *
   * Returns an Observable<MessageEvent> suitable for NestJS @Sse endpoints. Emits the current
   * status at once; if it is terminal the stream completes. Otherwise it subscribes to
   * `consultation_job_updates:{jobId}` and streams updates until a terminal status.
   *
   * TASK-1038 B3a:
   * - G6 — every frame is NAMED: `status` for each update, preceded by `progress` while the job
   *   runs and by `result` when it completes. Every frame's data is the FULL job status, so the
   *   browser hook's named listeners and a name-agnostic parser read the same objects.
   * - G10 — the status is re-read AFTER the SUBSCRIBE: a terminal update published between the
   *   first read and the subscription used to be lost, leaving the stream open forever. An idle
   *   stream sends an SSE comment every 15 s.
   */
  subscribeToJobUpdates(jobId: string): Observable<MessageEvent> {
    const channel = `${this.JOB_CHANNEL_PREFIX}${jobId}`;

    return new Observable<MessageEvent>((subscriber) => {
      // Track inner subscription so we can tear it down when the
      // outer Observable is unsubscribed (e.g. client disconnects).
      let innerSubscription: { unsubscribe(): void } | null = null;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let cancelled = false;
      let done = false;
      let last: string | null = null;

      const finish = (): void => {
        if (done) return;
        done = true;
        if (keepalive) clearInterval(keepalive);
        innerSubscription?.unsubscribe();
        subscriber.complete();
      };

      const emit = (raw: JobStatusResponse | Record<string, unknown>): void => {
        if (done) return;
        const update = raw as Record<string, unknown>;
        const normalized = update.status === 'CANCELED' ? { ...update, status: 'CANCELLED' } : update;
        const data = JSON.stringify(normalized);
        last = data;
        if (normalized.status === 'RUNNING' && typeof normalized.progress === 'number') subscriber.next({ type: 'progress', data } as MessageEvent);
        if (normalized.status === 'COMPLETED') subscriber.next({ type: 'result', data } as MessageEvent);
        subscriber.next({ type: 'status', data } as MessageEvent);
        if (isTerminalJobStatus(normalized.status as string)) {
          this.logger.log({ message: 'Job stream ending — terminal state', jobId, status: normalized.status });
          finish();
        }
      };

      this.getJobStatus(jobId)
        .then(async (currentStatus) => {
          // Job not found — emit error and complete
          if (!currentStatus) {
            subscriber.next({
              data: JSON.stringify({ error: 'Job not found', jobId }),
            } as MessageEvent);
            finish();
            return;
          }

          // The current status at once (and the end, when it is already terminal).
          emit(currentStatus);
          if (done || cancelled) return;

          const redisMessages$ = await this.redisSubscriber.subscribeToChannel(channel);
          // Teardown may have run while the SUBSCRIBE was in flight — create nothing then.
          if (cancelled) return;
          innerSubscription = redisMessages$.subscribe({
            next: (rawMessage: string) => {
              try {
                emit(JSON.parse(rawMessage) as JobStatusResponse);
              } catch {
                if (!done) subscriber.next({ type: 'status', data: rawMessage } as MessageEvent);
              }
            },
            error: (err) => subscriber.error(err),
            complete: () => finish(),
          });
          if (cancelled) {
            innerSubscription.unsubscribe();
            return;
          }

          // G10 — close the window between the first read and the SUBSCRIBE.
          const afterSubscribe = await this.getJobStatus(jobId);
          if (afterSubscribe && !done && JSON.stringify(afterSubscribe) !== last) {
            const changed = afterSubscribe.status !== currentStatus.status || afterSubscribe.progress !== currentStatus.progress;
            if (changed || isTerminalJobStatus(afterSubscribe.status)) emit(afterSubscribe);
          }
          if (!done && !cancelled) {
            keepalive = setInterval(() => {
              if (!done) subscriber.next({ comment: 'keepalive' } as unknown as MessageEvent);
            }, CONSULTATION_JOB_STREAM_KEEPALIVE_MS);
          }
        })
        .catch((error) => {
          this.logger.error({
            message: 'Error initializing job SSE subscription',
            jobId,
            error: error instanceof Error ? error.message : String(error),
          });
          subscriber.next({
            data: JSON.stringify({ error: 'Failed to subscribe to job updates', jobId }),
          } as MessageEvent);
          finish();
        });

      // Teardown: when the outer Observable is unsubscribed, release the inner
      // stream so the REFCOUNTED finalize inside `subscribeToChannel` fires.
      // Never call `unsubscribeFromChannel` here: it force-completes the SHARED
      // per-channel Subject and starves every other viewer of the same job.
      return () => {
        cancelled = true;
        if (keepalive) clearInterval(keepalive);
        innerSubscription?.unsubscribe();
      };
    });
  }

  /**
   * Store job status in Redis
   */
  private async storeJobStatus(jobId: string, status: ConsultationJobStatus): Promise<void> {
    await this.cacheService.setex(`${this.JOB_KEY_PREFIX}${jobId}`, this.JOB_TTL, JSON.stringify(status));
  }

  /**
   * Update job status and publish notification
   */
  private async updateJobStatus(jobId: string, update: Partial<ConsultationJobStatus>): Promise<void> {
    const current = await this.getJobStatus(jobId);
    if (!current) return;
    // A terminal job is final: a late progress/failure/completion never revives a CANCELLED job
    // (G14 — a cancelled harness run may still report back).
    if (isTerminalJobStatus(current.status)) return;

    const updated: ConsultationJobStatus = {
      ...current,
      ...update,
    };

    await this.storeJobStatus(jobId, updated);

    // Publish update via Redis pub/sub for SSE
    await this.cacheService.publish(`${this.JOB_CHANNEL_PREFIX}${jobId}`, JSON.stringify(updated));
  }

  /**
   * Notify job progress (called by processors)
   */
  async notifyProgress(jobId: string, progress: number, currentStep: string): Promise<void> {
    const current = await this.getJobStatus(jobId);
    const startedAt = current?.startedAt || new Date();

    await this.updateJobStatus(jobId, {
      status: 'RUNNING',
      progress,
      currentStep,
      startedAt,
    });

    this.logger.debug({
      message: 'Job progress update',
      jobId,
      progress,
      currentStep,
    });
  }

  /**
   * Notify job completion (called by processors)
   */
  async notifyComplete(jobId: string, result: unknown): Promise<void> {
    await this.updateJobStatus(jobId, {
      status: 'COMPLETED',
      progress: 100,
      currentStep: 'Completed',
      result,
      completedAt: new Date(),
    });

    this.logger.log({
      message: 'Job completed',
      jobId,
    });
  }

  /**
   * Notify job failure (called by processors)
   */
  async notifyFailed(jobId: string, error: string): Promise<void> {
    await this.updateJobStatus(jobId, {
      status: 'FAILED',
      error,
      completedAt: new Date(),
    });

    this.logger.error({
      message: 'Job failed',
      jobId,
      error,
    });
  }
}
