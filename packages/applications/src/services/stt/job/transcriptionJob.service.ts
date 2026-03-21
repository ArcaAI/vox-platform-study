import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    TranscriptionJobRepository,
    AsrPipelineRepository,
    TranscriptionJobFactory,
    ResourceType,
    SysEventType,
    TranscriptionJobStatus,
    TranscriptionJobType,
    JsonValue,
} from '@arcaai/domains';
import { ITranscriptionJobService } from './ITranscriptionJobService';
import {
    CreateJobRequest,
    CreateBatchJobRequest,
    CreateStreamingJobRequest,
    TranscriptionJobResponse,
    PaginatedTranscriptionJobResponse,
    TranscriptionJobStatusCountResponse,
} from './dto';
import { TranscriptionJobDtoMapper } from './transcriptionJob.dto.mapper';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

@Injectable()
export class TranscriptionJobService extends BaseService implements ITranscriptionJobService {
    constructor(
        private readonly jobRepository: TranscriptionJobRepository,
        private readonly pipelineRepository: AsrPipelineRepository,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>,
    ) {
        super(eventEmitter, clsService, ResourceType.TranscriptionJob);
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
     * Get jobs by consultation
     */
    async getByConsultation(consultationId: string): Promise<TranscriptionJobResponse[]> {
        const jobs = await this.jobRepository.findByConsultation(consultationId);
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
            filters: { tenantId } as any,
            page,
            limit,
            sort: [{ createdAt: 'desc' }],
        });

        const total = await this.jobRepository.count({
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
    async updateStatus(
        id: string,
        status: TranscriptionJobStatus,
        errorMessage?: string,
        errorCode?: string
    ): Promise<TranscriptionJobResponse> {
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
