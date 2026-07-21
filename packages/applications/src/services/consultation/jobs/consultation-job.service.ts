import { Inject, Injectable, Logger, MessageEvent } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable, map, takeWhile, finalize } from 'rxjs';
import { uuidv7 } from 'uuidv7';
import { JobQueue } from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import {
  GeneratePreSummaryJobPayload,
  GenerateSummaryJobPayload,
  GenerateComprehensiveSummaryJobPayload,
  ExtractNerJobPayload,
  ConsultationJobStatus,
  JobResponse,
  JobStatusResponse,
  JobStatusType,
} from './dto';

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

  createSummaryJob(
    consultationId: string,
    tenantId: string,
    userId: string,
    request: GenerateSummaryJobPayload['request'],
    callbackUrl?: string,
    /** Redis-backed dedupe key for the POST creation. */
    idempotencyKey?: string,
  ): Promise<JobResponse>;

  createComprehensiveSummaryJob(
    consultationId: string,
    tenantId: string,
    userId: string,
    request: GenerateComprehensiveSummaryJobPayload['request'],
    callbackUrl?: string,
    /** Redis-backed dedupe key for the POST creation. */
    idempotencyKey?: string,
  ): Promise<JobResponse>;

  createNerJob(
    contextItemId: string,
    consultationId: string,
    tenantId: string,
    userId: string,
    callbackUrl?: string,
    /** Redis-backed dedupe key for the POST creation. */
    idempotencyKey?: string,
  ): Promise<JobResponse>;

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
  // Idempotency-Key dedupe. The key namespace is intentionally
  // scoped by tenantId + userId so two doctors (or two tenants) cannot collide
  // on the same UUID and leak each other's jobIds.
  private readonly IDEMPOTENCY_KEY_PREFIX = 'idempotency:';
  private readonly IDEMPOTENCY_TTL = 86400; // 24 hours

  constructor(
    @InjectQueue(JobQueue.GeneratePreSummary) private preSummaryQueue: Queue,
    @InjectQueue(JobQueue.GenerateSummary) private summaryQueue: Queue,
    @InjectQueue(JobQueue.GenerateComprehensiveSummary) private comprehensiveSummaryQueue: Queue,
    @InjectQueue(JobQueue.ExtractNamedEntities) private nerQueue: Queue,
    @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    private readonly redisSubscriber: RedisSubscriberService,
  ) {
    this.logger.log('ConsultationJobService initialized');
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
    // Return the prior jobId on idempotency-key collision.
    const prior = await this.lookupIdempotentJobId('pre-summary', tenantId, userId, idempotencyKey);
    if (prior) {
      return { jobId: prior, status: 'PENDING', sseUrl: `/api/consultations/jobs/${prior}/sse`, estimatedSeconds: 30 };
    }

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

    await this.recordIdempotentJobId('pre-summary', tenantId, userId, idempotencyKey, jobId);

    this.logger.log({
      message: 'Created pre-summary job',
      jobId,
      consultationId,
      tenantId,
    });

    return {
      jobId,
      status: 'PENDING',
      sseUrl: `/api/consultations/jobs/${jobId}/sse`,
      estimatedSeconds: 30,
    };
  }

  /**
   * Create a summary generation job
   */
  async createSummaryJob(
    consultationId: string,
    tenantId: string,
    userId: string,
    request: GenerateSummaryJobPayload['request'],
    callbackUrl?: string,
    idempotencyKey?: string,
  ): Promise<JobResponse> {
    const prior = await this.lookupIdempotentJobId('summary', tenantId, userId, idempotencyKey);
    if (prior) {
      return { jobId: prior, status: 'PENDING', sseUrl: `/api/consultations/jobs/${prior}/sse`, estimatedSeconds: 60 };
    }

    const jobId = uuidv7();

    const payload: GenerateSummaryJobPayload = {
      jobId,
      consultationId,
      tenantId,
      userId,
      request,
      callbackUrl,
    };

    await this.summaryQueue.add('generate', payload, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });

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

    await this.recordIdempotentJobId('summary', tenantId, userId, idempotencyKey, jobId);

    this.logger.log({
      message: 'Created summary job',
      jobId,
      consultationId,
      tenantId,
    });

    return {
      jobId,
      status: 'PENDING',
      sseUrl: `/api/consultations/jobs/${jobId}/sse`,
      estimatedSeconds: 60,
    };
  }

  /**
   * Create a comprehensive cross-chain summary generation job
   */
  async createComprehensiveSummaryJob(
    consultationId: string,
    tenantId: string,
    userId: string,
    request: GenerateComprehensiveSummaryJobPayload['request'],
    callbackUrl?: string,
    idempotencyKey?: string,
  ): Promise<JobResponse> {
    const prior = await this.lookupIdempotentJobId('comprehensive', tenantId, userId, idempotencyKey);
    if (prior) {
      return { jobId: prior, status: 'PENDING', sseUrl: `/api/consultations/jobs/${prior}/sse`, estimatedSeconds: 120 };
    }

    const jobId = uuidv7();

    const payload: GenerateComprehensiveSummaryJobPayload = {
      jobId,
      consultationId,
      tenantId,
      userId,
      request,
      callbackUrl,
    };

    await this.comprehensiveSummaryQueue.add('generate', payload, {
      jobId,
      attempts: 2, // Fewer retries — comprehensive summaries are expensive
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });

    await this.storeJobStatus(jobId, {
      jobId,
      type: 'COMPREHENSIVE_SUMMARY',
      status: 'PENDING',
      consultationId,
      progress: 0,
      createdAt: new Date(),
      tenantId,
      userId,
    });

    await this.recordIdempotentJobId('comprehensive', tenantId, userId, idempotencyKey, jobId);

    this.logger.log({
      message: 'Created comprehensive summary job',
      jobId,
      consultationId,
      tenantId,
    });

    return {
      jobId,
      status: 'PENDING',
      sseUrl: `/api/consultations/jobs/${jobId}/sse`,
      estimatedSeconds: 120, // Longer estimate for cross-chain aggregation + AI
    };
  }

  /**
   * Create a NER extraction job
   */
  async createNerJob(
    contextItemId: string,
    consultationId: string,
    tenantId: string,
    userId: string,
    callbackUrl?: string,
    idempotencyKey?: string,
  ): Promise<JobResponse> {
    const prior = await this.lookupIdempotentJobId('ner', tenantId, userId, idempotencyKey);
    if (prior) {
      return { jobId: prior, status: 'PENDING', sseUrl: `/api/consultations/jobs/${prior}/sse`, estimatedSeconds: 15 };
    }

    const jobId = uuidv7();

    const payload: ExtractNerJobPayload = {
      jobId,
      contextItemId,
      consultationId,
      tenantId,
      userId,
      callbackUrl,
    };

    await this.nerQueue.add('extract', payload, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });

    await this.storeJobStatus(jobId, {
      jobId,
      type: 'NER',
      status: 'PENDING',
      contextItemId,
      consultationId,
      progress: 0,
      createdAt: new Date(),
      tenantId,
      userId,
    });

    await this.recordIdempotentJobId('ner', tenantId, userId, idempotencyKey, jobId);

    this.logger.log({
      message: 'Created NER job',
      jobId,
      contextItemId,
      consultationId,
      tenantId,
    });

    return {
      jobId,
      status: 'PENDING',
      sseUrl: `/api/consultations/jobs/${jobId}/sse`,
      estimatedSeconds: 15,
    };
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

    // Can't cancel completed/failed/cancelled jobs
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.status)) {
      return false;
    }

    // Get the appropriate queue
    let queue: Queue;
    switch (status.type) {
      case 'PRE_SUMMARY':
        queue = this.preSummaryQueue;
        break;
      case 'SUMMARY':
        queue = this.summaryQueue;
        break;
      case 'COMPREHENSIVE_SUMMARY':
        queue = this.comprehensiveSummaryQueue;
        break;
      case 'NER':
        queue = this.nerQueue;
        break;
      default:
        return false;
    }

    // Try to remove from queue
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'waiting' || state === 'delayed') {
        await job.remove();
      }
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
   * Returns an Observable<MessageEvent> suitable for NestJS @Sse endpoints.
   * Checks current job status first — if already terminal, emits the final
   * status and completes immediately. Otherwise, subscribes to the Redis
   * channel `consultation_job_updates:{jobId}` and streams updates until
   * a terminal state (COMPLETED, FAILED, CANCELLED) is received.
   *
   * Replaces the previous polling-based SSE implementation.
   */
  subscribeToJobUpdates(jobId: string): Observable<MessageEvent> {
    const channel = `${this.JOB_CHANNEL_PREFIX}${jobId}`;

    return new Observable<MessageEvent>((subscriber) => {
      // Track inner subscription so we can tear it down when the
      // outer Observable is unsubscribed (e.g. client disconnects).
      let innerSubscription: { unsubscribe(): void } | null = null;

      this.getJobStatus(jobId)
        .then(async (currentStatus) => {
          // Job not found — emit error and complete
          if (!currentStatus) {
            subscriber.next({
              data: JSON.stringify({ error: 'Job not found', jobId }),
            } as MessageEvent);
            subscriber.complete();
            return;
          }

          const terminalStatuses: JobStatusType[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

          // Job already in terminal state — emit final status and complete
          if (terminalStatuses.includes(currentStatus.status)) {
            this.logger.log({
              message: 'Job already in terminal state — emitting final status',
              jobId,
              status: currentStatus.status,
            });
            subscriber.next({
              data: JSON.stringify(currentStatus),
            } as MessageEvent);
            subscriber.complete();
            return;
          }

          // Emit current status immediately so the client sees something right away
          subscriber.next({
            data: JSON.stringify(currentStatus),
          } as MessageEvent);

          // Subscribe to Redis channel for real-time updates
          const redisMessages$ = await this.redisSubscriber.subscribeToChannel(channel);

          const sseStream$ = redisMessages$.pipe(
            map((rawMessage: string): MessageEvent => {
              try {
                const parsed = JSON.parse(rawMessage) as JobStatusResponse;
                return { data: JSON.stringify(parsed) } as MessageEvent;
              } catch {
                return { data: rawMessage } as MessageEvent;
              }
            }),
            takeWhile((event: MessageEvent) => {
              try {
                const data = JSON.parse(event.data as string);
                const isTerminal = terminalStatuses.includes(data.status);
                if (isTerminal) {
                  this.logger.log({
                    message: 'SSE stream ending — job reached terminal state',
                    jobId,
                    status: data.status,
                  });
                }
                return !isTerminal;
              } catch {
                return true;
              }
            }, true), // Include the terminal event
            finalize(() => {
              this.logger.log({
                message: 'SSE stream finalized — cleaning up Redis subscription',
                jobId,
                channel,
              });
              this.redisSubscriber.unsubscribeFromChannel(channel);
            }),
          );

          innerSubscription = sseStream$.subscribe({
            next: (event) => subscriber.next(event),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          });
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
          subscriber.complete();
        });

      // Teardown: when the outer Observable is unsubscribed,
      // unsubscribe the inner stream so finalize() fires.
      return () => {
        if (innerSubscription) {
          innerSubscription.unsubscribe();
        }
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
   * Build the Redis key for an Idempotency-Key. Scoped by
   * job type, tenantId, and userId so two doctors or two tenants cannot
   * collide on the same UUID and inadvertently reuse each other's jobIds.
   */
  private buildIdempotencyRedisKey(jobType: string, tenantId: string, userId: string, idempotencyKey: string): string {
    return `${this.IDEMPOTENCY_KEY_PREFIX}${jobType}:${tenantId}:${userId}:${idempotencyKey}`;
  }

  /**
   * Look up a prior jobId for this Idempotency-Key. Returns
   * `null` when no key was provided or when no prior call exists; callers
   * proceed to create a new job in that case.
   */
  private async lookupIdempotentJobId(jobType: string, tenantId: string, userId: string, idempotencyKey?: string): Promise<string | null> {
    if (!idempotencyKey) return null;
    try {
      const cached = await this.cacheService.get(this.buildIdempotencyRedisKey(jobType, tenantId, userId, idempotencyKey));
      if (cached && cached.length > 0) {
        this.logger.log({
          message: 'Idempotency hit — returning prior jobId',
          jobType,
          tenantId,
          userId,
          idempotencyKey,
          priorJobId: cached,
        });
        return cached;
      }
    } catch (err) {
      // Best-effort dedupe — never block the caller on a Redis miss.
      this.logger.warn({
        message: 'Idempotency lookup failed — falling through to job creation',
        jobType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  /**
   * Persist the newly-created jobId under the Idempotency-Key
   * with a 24h TTL. No-op when no key is supplied.
   */
  private async recordIdempotentJobId(
    jobType: string,
    tenantId: string,
    userId: string,
    idempotencyKey: string | undefined,
    jobId: string,
  ): Promise<void> {
    if (!idempotencyKey) return;
    try {
      await this.cacheService.setex(this.buildIdempotencyRedisKey(jobType, tenantId, userId, idempotencyKey), this.IDEMPOTENCY_TTL, jobId);
    } catch (err) {
      this.logger.warn({
        message: 'Idempotency recording failed — duplicate POSTs may create duplicate jobs',
        jobType,
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Update job status and publish notification
   */
  private async updateJobStatus(jobId: string, update: Partial<ConsultationJobStatus>): Promise<void> {
    const current = await this.getJobStatus(jobId);
    if (!current) return;

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
