import {
  AsrPipelineRepository,
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
import { ITranscriptionJobService } from './ITranscriptionJobService';
import {
  CreateBatchJobRequest,
  CreateJobRequest,
  CreateStreamingJobRequest,
  PaginatedTranscriptionJobResponse,
  TranscriptionJobResponse,
  TranscriptionJobStatusCountResponse,
} from './dto';
import { TranscriptionJobDtoMapper } from './transcriptionJob.dto.mapper';

@Injectable()
export class TranscriptionJobService extends BaseService implements ITranscriptionJobService {
  constructor(
    private readonly jobRepository: TranscriptionJobRepository,
    private readonly pipelineRepository: AsrPipelineRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-369 Phase 3C — optional + trailing so existing positional fixtures
    // keep their arity; when wired, the completed job's resultText/resultMetadata
    // are encrypted before persist (dual-write soak).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-392 (Phase 3, M2) — optional (append-only DI); enforces the plan
    // `monthlyTranscriptionMinutes` meter on submit (kill-switch-gated, → 429
    // once the tenant has consumed its rolling-monthly minutes).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.TranscriptionJob);
  }

  private readonly logger = new Logger(TranscriptionJobService.name);

  /**
   * TASK-369 — encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  /**
   * Create a transcription job
   */
  async create(dto: CreateJobRequest): Promise<TranscriptionJobResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Verify pipeline exists
    const pipeline = await this.pipelineRepository.findById(dto.pipelineId);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${dto.pipelineId} not found`);
    }

    // Validate batch job requires mediaId
    if (dto.jobType === TranscriptionJobType.BATCH && !dto.mediaId) {
      throw new BadRequestException('Media ID is required for batch transcription jobs');
    }

    // TASK-392 (Phase 3, M2) — block a new transcription submit once the tenant
    // has consumed its rolling-monthly transcription-minutes allowance.
    // Kill-switch-gated (Q9); → 429 when at/over the cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyTranscriptionMinutes');

    const job = TranscriptionJobFactory.CreateTranscriptionJob({
      tenantId,
      jobType: dto.jobType,
      pipelineId: dto.pipelineId,
      consultationId: dto.consultationId,
      mediaId: dto.mediaId,
      maxRetries: dto.maxRetries,
      createdBy: userId ?? undefined,
    });

    const saved = await this.jobRepository.create(job);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { jobType: dto.jobType, pipelineId: dto.pipelineId },
    });

    return TranscriptionJobDtoMapper.toResponse(saved);
  }

  /**
   * Create a batch transcription job
   */
  async createBatchJob(dto: CreateBatchJobRequest): Promise<TranscriptionJobResponse> {
    return this.create({
      ...dto,
      jobType: TranscriptionJobType.BATCH,
    });
  }

  /**
   * Create a streaming transcription job
   */
  async createStreamingJob(dto: CreateStreamingJobRequest): Promise<TranscriptionJobResponse> {
    return this.create({
      ...dto,
      jobType: TranscriptionJobType.STREAMING,
    });
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
   * Get job by ID with pipeline details
   */
  async getByIdWithPipeline(id: string): Promise<TranscriptionJobResponse | null> {
    const job = await this.jobRepository.findWithPipeline(id);
    if (!job) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: job.id,
    });

    return TranscriptionJobDtoMapper.toResponse(job);
  }

  /**
   * Get jobs by consultation.
   *
   * TASK-307 W3.8 (AC-12) — defense-in-depth: the TASK-305 Prisma
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
   * EU-02 (TASK-336) — owner-scoped variant of {@link getByConsultation} for
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
   * Get paginated list of jobs
   */
  async list(page: number = 1, limit: number = 20): Promise<PaginatedTranscriptionJobResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const jobs = await this.jobRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
      page,
      limit,
      sort: [{ createdAt: 'desc' }],
    });

    const total = await this.jobRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
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
   * TASK-319 F3 — owner-scoped variant of {@link list}. Returns only the jobs
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
   * TASK-319 F3 — owner-scoped variant of {@link getByStatus}.
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
   * TASK-319 F3 — owner-scoped variant of {@link getStatusCounts}.
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

    // TASK-369 Phase 3C — encrypt resultText/resultMetadata into the ciphertext
    // columns before the completing persist (dual-write; plaintext kept for soak).
    await this.encryptBestEffort('TranscriptionJob', () =>
      this.jobRepository.encryptFieldsIntoEntity(job, this.secretsService!),
    );

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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const updated = await this.jobRepository.update(id, job);
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
   * EU-01 (TASK-336) — creator-scoped cancel for the end-user surface.
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
   * EU-01 (TASK-336) — creator-scoped retry (mirrors {@link cancelJobForOwner}).
   */
  async retryJobForOwner(ownerId: string, id: string): Promise<TranscriptionJobResponse> {
    await this.assertCreatedBy(id, ownerId);
    return this.retryJob(id);
  }

  /**
   * Assert the job exists AND was created by `ownerId`. Both "not found" and
   * "not yours" collapse to the same `NotFoundException` (DEF-C3: no existence
   * leak between same-tenant peers).
   */
  private async assertCreatedBy(id: string, ownerId: string): Promise<void> {
    const job = await this.jobRepository.findById(id);
    if (!job || job.createdBy !== ownerId) {
      throw new NotFoundException(`Job ${id} not found`);
    }
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
