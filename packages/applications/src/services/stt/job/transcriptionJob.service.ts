import {
  JsonValue,
  ResourceType,
  SysEventType,
  TranscriptionJobFactory,
  TranscriptionJobRepository,
  TranscriptionJobStatus,
  TranscriptionJobType,
} from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { IProviderCapacityService } from '../../provider-capacity/IProviderCapacityService';
import { asrProviderFromSpec } from '../asr-provider';
// TASK-999 (D-6(a)) — which entry of `resolvedSpec.fallback.chain` actually served.
import { resolveServedBy, type ServedBy } from '../served-by';
import {
  CompletedStreamSessionJob,
  CompleteStreamSessionJobInput,
  CreateStreamSessionJobInput,
  ITranscriptionJobService,
} from './ITranscriptionJobService';
import {
  BatchDispatchEnvelope,
  CreateBatchJobInput,
  CreateJobInput,
  CreateStreamingJobInput,
  PaginatedTranscriptionJobResponse,
  TranscriptionJobResponse,
  TranscriptionJobStatusCountResponse,
} from './dto';
import { TranscriptionJobDtoMapper } from './transcriptionJob.dto.mapper';

@Injectable()
export class TranscriptionJobService extends BaseService implements ITranscriptionJobService {
  constructor(
    private readonly jobRepository: TranscriptionJobRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional + trailing so existing positional fixtures
    // keep their arity; when wired, the completed job's resultText/resultMetadata
    // are encrypted before persist (dual-write soak).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Optional (append-only DI); enforces the plan
    // `monthlyTranscriptionMinutes` meter on submit (kill-switch-gated, → 429
    // once the tenant has consumed its rolling-monthly minutes).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // TASK-998 OD-4 — the OUTBOUND vendor-capacity guard. A BATCH job reaches the
    // cloud ASR provider over sync REST, so it is the `requestsPerMinute`
    // dimension that binds here (the concurrent-socket dimension is enforced at
    // streaming-session open instead). Optional + trailing like the five above;
    // absent ⇒ unbounded, exactly as before.
    @Optional() @Inject(IProviderCapacityService) private readonly providerCapacity?: IProviderCapacityService,
  ) {
    super(eventEmitter, clsService, ResourceType.TranscriptionJob);
  }

  private readonly logger = new Logger(TranscriptionJobService.name);

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  /**
   * Create a transcription job
   */
  async create(dto: CreateJobInput): Promise<TranscriptionJobResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // A job is keyed to the ASR Agent VERSION that runs it (+ the resolved spec
    // snapshot, so it is reproducible from its own row). There is no other
    // selector: the `pipelineId` path was retired with `AsrPipeline` (TASK-1006).
    if (!dto.agentVersionId) {
      throw new BadRequestException('agentVersionId (with resolvedSpec) is required');
    } else if (!dto.resolvedSpec) {
      throw new BadRequestException('resolvedSpec is required when agentVersionId is set');
    }

    // Validate batch job requires mediaId
    if (dto.jobType === TranscriptionJobType.BATCH && !dto.mediaId) {
      throw new BadRequestException('Media ID is required for batch transcription jobs');
    }

    // Block a new transcription submit once the tenant
    // has consumed its rolling-monthly transcription-minutes allowance.
    // Kill-switch-gated; → 429 when at/over the cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyTranscriptionMinutes');

    // TASK-998 OD-4 — the tenant's share of the VENDOR's per-minute REST cap for
    // the provider this job will actually run on. Distinct from the meter above:
    // that one bounds what the tenant BOUGHT over a month, this one bounds what
    // the vendor account will ACCEPT in the next sixty seconds. Checked before
    // the row is written so a refused job leaves nothing behind, and kill-switch
    // gated inside; → 429 over cap, fail-OPEN if Redis cannot answer.
    await this.providerCapacity?.assertRequestRate(tenantId, asrProviderFromSpec(dto.resolvedSpec));

    const job = TranscriptionJobFactory.CreateTranscriptionJob({
      tenantId,
      jobType: dto.jobType,
      agentVersionId: dto.agentVersionId ?? null,
      resolvedSpec: (dto.resolvedSpec as JsonValue | undefined) ?? null,
      consultationId: dto.consultationId,
      mediaId: dto.mediaId,
      maxRetries: dto.maxRetries,
      createdBy: userId ?? undefined,
    });

    const saved = await this.jobRepository.create(job);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { jobType: dto.jobType, agentVersionId: dto.agentVersionId ?? null },
    });

    return TranscriptionJobDtoMapper.toResponse(saved);
  }

  /**
   * Create a batch transcription job
   */
  async createBatchJob(dto: CreateBatchJobInput): Promise<TranscriptionJobResponse> {
    return this.create({
      ...dto,
      jobType: TranscriptionJobType.BATCH,
    });
  }

  /**
   * Create a streaming transcription job
   */
  async createStreamingJob(dto: CreateStreamingJobInput): Promise<TranscriptionJobResponse> {
    return this.create({
      ...dto,
      jobType: TranscriptionJobType.STREAMING,
    });
  }

  /**
   * TASK-999 (D-5(a)) — write the row that mirrors a realtime STT session.
   *
   * Deliberately NOT {@link createStreamingJob}, which routes through
   * {@link create} and so reads its tenant from CLS, runs the batch entitlement
   * and vendor-rate guards, and starts the row QUEUED. None of that fits here:
   * the streaming plane has already taken its OWN allowance and concurrency
   * checks at session open (`StreamingSessionService.createSession`), it is
   * reached from paths that carry the tenant on a DTO rather than in CLS, and a
   * live session is PROCESSING from the instant it opens — there is no queue and
   * no worker to claim it.
   *
   * `workerId` is the STT session id: the process holding this job IS that
   * session, and naming it is what lets an operator reading a stranded row find
   * the session it belongs to.
   */
  async createForStreamSession(input: CreateStreamSessionJobInput): Promise<TranscriptionJobResponse> {
    const job = TranscriptionJobFactory.CreateTranscriptionJob({
      tenantId: input.tenantId,
      jobType: TranscriptionJobType.STREAMING,
      streamSessionId: input.streamSessionId,
      agentVersionId: input.agentVersionId ?? null,
      resolvedSpec: (input.resolvedSpec as JsonValue | undefined) ?? null,
      consultationId: input.consultationId,
      createdBy: input.userId ?? undefined,
    });

    // The factory hardcodes QUEUED (the batch broker's entry state). Set the
    // live state on the entity BEFORE the insert so the row is written once,
    // rather than inserting a lie and immediately updating it away.
    job.status = TranscriptionJobStatus.PROCESSING;
    job.startedAt = new Date();
    job.workerId = input.streamSessionId;

    const saved = await this.jobRepository.create(job);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { jobType: TranscriptionJobType.STREAMING, streamSessionId: input.streamSessionId },
    });

    return TranscriptionJobDtoMapper.toResponse(saved);
  }

  /**
   * TASK-999 — close the row a realtime session opened, at teardown.
   *
   * Looked up by `streamSessionId` (`TranscriptionJob_streamSessionId_idx`) so
   * the teardown paths that hold only a session id — the SIGTERM sweep, the
   * Redis removal-retry drain, the compat gateway, the STT reaper push-back —
   * can all reach it without carrying a job id they never had.
   *
   * Returns `null` when there is no row (a session opened before this shipped,
   * or one whose row write failed — session creation never fails on it) and when
   * the row is ALREADY closed. That second case is what keeps teardown
   * idempotent: `removeSession` and the reaper push-back can both arrive for one
   * session, and the first one to land owns the completion.
   *
   * `servedBy` is derived HERE rather than by the caller because the row is what
   * carries `resolvedSpec` — the gateway does not hold the spec at teardown — and
   * it is returned so the caller can stamp the same model onto its usage rows.
   */
  async completeStreamSessionJob(streamSessionId: string, input: CompleteStreamSessionJobInput): Promise<CompletedStreamSessionJob | null> {
    const [job] = await this.jobRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { streamSessionId } as any,
      limit: 1,
      sort: [{ createdAt: 'desc' }],
    });
    if (!job) return null;

    const resolvedSpec = job.resolvedSpec ?? null;
    if (job.completedAt) {
      // Already closed by whichever teardown path got here first. Hand back what
      // the row records so the caller can still stamp its usage rows, but write
      // nothing — a second completion would only move `updatedAt`.
      return { jobId: job.id, resolvedSpec, servedBy: (job.servedBy as unknown as ServedBy | null) ?? null, alreadyCompleted: true };
    }

    const servedBy = resolveServedBy(resolvedSpec, input.engine);

    // Set directly rather than through `entity.complete()`: that transition is
    // the BATCH worker's (it demands a `resultText`, which the gateway does not
    // hold at teardown — a realtime transcript is written as its own
    // `ContextItem`, never onto this row). Same shape `updateStatus` already
    // uses for a non-batch status change.
    job.status = TranscriptionJobStatus.COMPLETED;
    job.completedAt = new Date();
    job.progress = 100;
    if (servedBy) job.servedBy = servedBy as unknown as JsonValue;
    // NULL means never measured; only write a number when one was actually taken.
    if (input.resultWordCount != null) job.resultWordCount = input.resultWordCount;
    if (input.resultCharCount != null) job.resultCharCount = input.resultCharCount;

    await this.jobRepository.update(job.id, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: job.id,
      data: { status: TranscriptionJobStatus.COMPLETED, streamSessionId },
    });

    return { jobId: job.id, resolvedSpec, servedBy, alreadyCompleted: false };
  }

  /**
   * Get job by ID
   */
  async getById(id: string): Promise<TranscriptionJobResponse | null> {
    const job = await this.jobRepository.findById(id);
    if (!job) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: job.id,
    });

    return TranscriptionJobDtoMapper.toResponse(job);
  }

  /**
   * Get jobs by consultation.
   *
   * Defense-in-depth: the Prisma
   * `tenantScopeFilter` extension already auto-applies `tenantId` for
   * any caller bound to a tenant, but super-admins bypass that extension
   * by design. Explicitly anchor the tenant filter at the service layer
   * (matching the `list`/`getByStatus`/`getStatusCounts` posture) so a
   * super-admin call can never return cross-tenant rows by mistake.
   */
  async getByConsultation(consultationId: string): Promise<TranscriptionJobResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const jobs = await this.jobRepository.findAll({
      filters: { consultationId, tenantId } as Record<string, unknown>,
      sort: [{ createdAt: 'desc' }],
    });
    return jobs.map(TranscriptionJobDtoMapper.toResponse);
  }

  /**
   * EU-02 — owner-scoped variant of {@link getByConsultation} for
   * the end-user surface. In addition to the tenant filter, it restricts the
   * result to the caller's OWN jobs (`createdBy`), so a same-tenant peer cannot
   * read another user's transcription jobs by guessing a consultation id. The
   * tenant-wide view stays on the admin surface.
   */
  async getByConsultationForOwner(ownerId: string, consultationId: string): Promise<TranscriptionJobResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const jobs = await this.jobRepository.findAll({
      filters: { consultationId, tenantId, createdBy: ownerId } as Record<string, unknown>,
      sort: [{ createdAt: 'desc' }],
    });
    return jobs.map(TranscriptionJobDtoMapper.toResponse);
  }

  /**
   * Get paginated list of jobs.
   *
   * TASK-999 — `jobType` narrows to ONE kind. Absent means BOTH: realtime
   * sessions only became rows in this ticket, so a caller that expresses no
   * opinion must keep seeing everything its tenant has. Backed by
   * `TranscriptionJob_tenant_jobType_created_idx`.
   */
  async list(page: number = 1, limit: number = 20, jobType?: TranscriptionJobType): Promise<PaginatedTranscriptionJobResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const filters = { tenantId, ...(jobType ? { jobType } : {}) };

    const jobs = await this.jobRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: filters as any,
      page,
      limit,
      sort: [{ createdAt: 'desc' }],
    });

    const total = await this.jobRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: filters as any,
    });

    return {
      data: jobs.map(TranscriptionJobDtoMapper.toResponse),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get jobs by status
   */
  async getByStatus(status: TranscriptionJobStatus): Promise<TranscriptionJobResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const jobs = await this.jobRepository.findJobsByStatus(tenantId, status);
    return jobs.map(TranscriptionJobDtoMapper.toResponse);
  }

  /**
   * Owner-scoped variant of {@link list}. Returns only the jobs
   * the given user created (`createdBy`). Used by the end-user
   * `/audio/transcription-jobs` surface so a caller never sees other users'
   * jobs in their tenant.
   */
  async listForOwner(ownerId: string, page: number = 1, limit: number = 20): Promise<PaginatedTranscriptionJobResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters = { tenantId, createdBy: ownerId } as any;

    const jobs = await this.jobRepository.findAll({ filters, page, limit, sort: [{ createdAt: 'desc' }] });
    const total = await this.jobRepository.count({ filters });

    return {
      data: jobs.map(TranscriptionJobDtoMapper.toResponse),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Owner-scoped variant of {@link getByStatus}.
   */
  async getByStatusForOwner(ownerId: string, status: TranscriptionJobStatus): Promise<TranscriptionJobResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const jobs = await this.jobRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId, createdBy: ownerId, status } as any,
      sort: [{ createdAt: 'desc' }],
    });
    return jobs.map(TranscriptionJobDtoMapper.toResponse);
  }

  /**
   * Owner-scoped variant of {@link getStatusCounts}.
   */
  async getStatusCountsForOwner(ownerId: string): Promise<TranscriptionJobStatusCountResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const counts = await this.jobRepository.countByStatus(tenantId, ownerId);
    return {
      queued: counts[TranscriptionJobStatus.QUEUED],
      processing: counts[TranscriptionJobStatus.PROCESSING],
      completed: counts[TranscriptionJobStatus.COMPLETED],
      failed: counts[TranscriptionJobStatus.FAILED],
      cancelled: counts[TranscriptionJobStatus.CANCELLED],
      dead: counts[TranscriptionJobStatus.DEAD],
    };
  }

  /**
   * Get job status counts
   */
  async getStatusCounts(): Promise<TranscriptionJobStatusCountResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const counts = await this.jobRepository.countByStatus(tenantId);
    return {
      queued: counts[TranscriptionJobStatus.QUEUED],
      processing: counts[TranscriptionJobStatus.PROCESSING],
      completed: counts[TranscriptionJobStatus.COMPLETED],
      failed: counts[TranscriptionJobStatus.FAILED],
      cancelled: counts[TranscriptionJobStatus.CANCELLED],
      dead: counts[TranscriptionJobStatus.DEAD],
    };
  }

  /**
   * Update job status (for internal use)
   */
  async updateStatus(id: string, status: TranscriptionJobStatus, errorMessage?: string, errorCode?: string): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.status = status;
    if (errorMessage) job.errorMessage = errorMessage;
    if (errorCode) job.errorCode = errorCode;

    const updated = await this.jobRepository.update(id, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { status },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Start processing a job (for internal use)
   */
  async startProcessing(id: string, workerId: string): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.startProcessing(workerId);
    const updated = await this.jobRepository.update(id, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { status: TranscriptionJobStatus.PROCESSING, workerId },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Update job progress (for internal use)
   */
  async updateProgress(id: string, progress: number): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.updateProgress(progress);
    const updated = await this.jobRepository.update(id, job);

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Complete a job (for internal use)
   */
  async completeJob(id: string, resultText: string, resultMetadata?: JsonValue): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.complete(resultText, resultMetadata);

    // Encrypt resultText/resultMetadata into the ciphertext
    // columns before the completing persist (dual-write; plaintext kept for soak).
    await this.encryptBestEffort('TranscriptionJob', () => this.jobRepository.encryptFieldsIntoEntity(job, this.secretsService!));

    const updated = await this.jobRepository.update(id, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { status: TranscriptionJobStatus.COMPLETED },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Fail a job (for internal use)
   */
  async failJob(id: string, errorMessage: string, errorCode?: string): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.fail(errorMessage, errorCode);
    const updated = await this.jobRepository.update(id, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { status: TranscriptionJobStatus.FAILED, errorMessage },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Cancel a job
   */
  async cancelJob(id: string): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.cancel();
    const updated = await this.jobRepository.update(id, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { status: TranscriptionJobStatus.CANCELLED },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Retry a failed job
   */
  async retryJob(id: string): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    const canRetry = job.incrementRetry();
    if (!canRetry) {
      job.markAsDead();
      await this.jobRepository.update(id, job);
      throw new BadRequestException(`Job ${id} has exceeded maximum retries`);
    }

    const updated = await this.jobRepository.update(id, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { status: TranscriptionJobStatus.QUEUED, retryCount: job.retryCount },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * EU-01 — creator-scoped cancel for the end-user surface.
   *
   * The plain {@link cancelJob} stays tenant-scoped for internal/admin use.
   * This variant additionally requires the caller to be the job's `createdBy`,
   * so a same-tenant peer cannot cancel a job they did not create via id
   * enumeration. A non-creator (or unknown id) 404s with no existence leak,
   * mirroring the `@TenantOwnedResource({ scope: 'creator' })` posture used for
   * `ConsultationJob` (the route-guard creator branch resolves a `userId`;
   * `TranscriptionJob` is `createdBy`-scoped, so it is enforced here instead).
   */
  async cancelJobForOwner(ownerId: string, id: string): Promise<TranscriptionJobResponse> {
    await this.assertCreatedBy(id, ownerId);
    return this.cancelJob(id);
  }

  /**
   * EU-01 — creator-scoped retry (mirrors {@link cancelJobForOwner}).
   */
  async retryJobForOwner(ownerId: string, id: string): Promise<TranscriptionJobResponse> {
    await this.assertCreatedBy(id, ownerId);
    return this.retryJob(id);
  }

  /**
   * Assert the job exists AND was created by `ownerId`. Both "not found" and
   * "not yours" collapse to the same `NotFoundException` — no existence
   * leak between same-tenant peers.
   */
  private async assertCreatedBy(id: string, ownerId: string): Promise<void> {
    const job = await this.jobRepository.findById(id);
    if (!job || job.createdBy !== ownerId) {
      throw new NotFoundException(`Job ${id} not found`);
    }
  }

  /**
   * TASK-992 FU-1 — record what was published to the broker for this job.
   *
   * No sys-event: this is bookkeeping about a message, not a state change a
   * reader of the row cares about, and an audit entry per dispatch would bury
   * the lifecycle events that matter. Same reasoning as {@link setContextItem}.
   */
  async recordDispatchEnvelope(id: string, envelope: BatchDispatchEnvelope): Promise<void> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.recordDispatch(envelope as unknown as JsonValue);
    await this.jobRepository.update(id, job);
  }

  /**
   * TASK-992 FU-1 — everything the retry path needs to re-publish this job,
   * creator-scoped exactly like {@link retryJobForOwner}.
   *
   * `envelope` is `null` for any row dispatched before FU-1 shipped, which the
   * caller must treat as a refusal: those jobs carry no `audioUri` anywhere, so
   * flipping them to QUEUED would recreate the very defect this closes.
   */
  async getDispatchContextForOwner(
    ownerId: string,
    id: string,
  ): Promise<{ envelope: BatchDispatchEnvelope | null; resolvedSpec: JsonValue | null; tenantId: string }> {
    const job = await this.jobRepository.findById(id);
    if (!job || job.createdBy !== ownerId) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    return {
      envelope: (job.dispatchEnvelope as unknown as BatchDispatchEnvelope | null | undefined) ?? null,
      resolvedSpec: job.resolvedSpec ?? null,
      tenantId: job.tenantId,
    };
  }

  /**
   * Set context item ID for a job
   */
  async setContextItem(id: string, contextItemId: string): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    job.setContextItem(contextItemId);
    const updated = await this.jobRepository.update(id, job);

    return TranscriptionJobDtoMapper.toResponse(updated);
  }
}
