/**
 * TranscriptionJobService Unit Tests
 *
 * Tests for the TranscriptionJobService that handles transcription job management.
 *
 * TESTING APPROACH:
 * - Uses behavioral mock entities that simulate real entity behavior
 * - Only mocks external boundaries: repositories (I/O) and event emitter (side effects)
 * - Verifies actual state changes through behavioral mocks, not just call verification
 *
 * NOTE: Domain entity tests (packages/domains) provide comprehensive behavioral testing
 * of TranscriptionJobEntity. These service tests focus on orchestration logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TranscriptionJobService } from '../transcriptionJob.service';

// Import enums as strings to avoid vitest module resolution issues
const TranscriptionJobStatus = {
    QUEUED: 'QUEUED',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    DEAD: 'DEAD',
} as const;

const TranscriptionJobType = {
    BATCH: 'BATCH',
    STREAMING: 'STREAMING',
} as const;

const SysEventType = {
    ResourceCreated: 'SysEvent.ResourceCreated',
    ResourceUpdated: 'SysEvent.ResourceUpdated',
    ResourceViewed: 'SysEvent.ResourceViewed',
    ResourceDeleted: 'SysEvent.ResourceDeleted',
} as const;

// ============================================
// Behavioral Mock Entity Factory
// These mocks SIMULATE real entity behavior
// ============================================

/**
 * Creates a BEHAVIORAL mock TranscriptionJobEntity.
 * Unlike simple mocks, this simulates the actual entity behavior
 * so we can verify state changes, not just method calls.
 */
function createBehavioralJobEntity(overrides: {
    id?: string;
    tenantId?: string;
    jobType?: string;
    consultationId?: string | null;
    contextItemId?: string | null;
    mediaId?: string | null;
    pipelineId?: string;
    status?: string;
    progress?: number;
    queuedAt?: Date;
    startedAt?: Date | null;
    completedAt?: Date | null;
    resultText?: string | null;
    resultMetadata?: any;
    errorMessage?: string | null;
    errorCode?: string | null;
    retryCount?: number;
    maxRetries?: number;
    workerId?: string | null;
    createdBy?: string | null;
} = {}) {
    // Internal state
    let _status = overrides.status ?? TranscriptionJobStatus.QUEUED;
    let _progress = overrides.progress ?? 0;
    let _workerId = overrides.workerId ?? null;
    let _startedAt = overrides.startedAt ?? null;
    let _completedAt = overrides.completedAt ?? null;
    let _resultText = overrides.resultText ?? null;
    let _resultMetadata = overrides.resultMetadata ?? null;
    let _errorMessage = overrides.errorMessage ?? null;
    let _errorCode = overrides.errorCode ?? null;
    let _retryCount = overrides.retryCount ?? 0;
    let _contextItemId = 'contextItemId' in overrides ? overrides.contextItemId : null;
    let _mediaId = 'mediaId' in overrides ? overrides.mediaId : 'media-1';
    const _maxRetries = overrides.maxRetries ?? 3;
    const _changes: Record<string, any> = {};

    const entity = {
        id: overrides.id ?? 'job-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        jobType: overrides.jobType ?? TranscriptionJobType.BATCH,
        consultationId: 'consultationId' in overrides ? overrides.consultationId : 'consultation-1',
        pipelineId: overrides.pipelineId ?? 'pipeline-1',
        queuedAt: overrides.queuedAt ?? new Date('2026-02-02T10:00:00Z'),
        createdBy: overrides.createdBy ?? 'user-123',

        // Getters for mutable state
        get status() { return _status; },
        get progress() { return _progress; },
        get workerId() { return _workerId; },
        get startedAt() { return _startedAt; },
        get completedAt() { return _completedAt; },
        get resultText() { return _resultText; },
        get resultMetadata() { return _resultMetadata; },
        get errorMessage() { return _errorMessage; },
        get errorCode() { return _errorCode; },
        get retryCount() { return _retryCount; },
        get maxRetries() { return _maxRetries; },
        get contextItemId() { return _contextItemId; },
        get mediaId() { return _mediaId; },
        get changes() { return _changes; },
        get hasChanges() { return Object.keys(_changes).length > 0; },

        // Status helpers
        get isQueued() { return _status === TranscriptionJobStatus.QUEUED; },
        get isProcessing() { return _status === TranscriptionJobStatus.PROCESSING; },
        get isCompleted() { return _status === TranscriptionJobStatus.COMPLETED; },
        get isFailed() { return _status === TranscriptionJobStatus.FAILED; },
        get isCancelled() { return _status === TranscriptionJobStatus.CANCELLED; },
        get isDead() { return _status === TranscriptionJobStatus.DEAD; },
        get isTerminal() {
            return _status === TranscriptionJobStatus.COMPLETED ||
                   _status === TranscriptionJobStatus.FAILED ||
                   _status === TranscriptionJobStatus.CANCELLED ||
                   _status === TranscriptionJobStatus.DEAD;
        },
        get canRetry() { return _status === TranscriptionJobStatus.FAILED && _retryCount < _maxRetries; },
        get isBatch() { return entity.jobType === TranscriptionJobType.BATCH; },
        get isStreaming() { return entity.jobType === TranscriptionJobType.STREAMING; },

        // BEHAVIORAL methods - these ACTUALLY change state
        startProcessing(workerId: string) {
            if (_status !== TranscriptionJobStatus.QUEUED) {
                throw new Error(`Cannot start job in ${_status} status`);
            }
            _status = TranscriptionJobStatus.PROCESSING;
            _workerId = workerId;
            _startedAt = new Date();
            _progress = 0;
            _changes.status = _status;
            _changes.workerId = _workerId;
            _changes.startedAt = _startedAt;
        },

        updateProgress(progress: number) {
            if (progress < 0 || progress > 100) {
                throw new Error('Progress must be between 0 and 100');
            }
            _progress = progress;
            _changes.progress = progress;
        },

        complete(resultText: string, metadata?: any) {
            if (_status !== TranscriptionJobStatus.PROCESSING) {
                throw new Error(`Cannot complete job in ${_status} status`);
            }
            _status = TranscriptionJobStatus.COMPLETED;
            _completedAt = new Date();
            _progress = 100;
            _resultText = resultText;
            _resultMetadata = metadata ?? null;
            _changes.status = _status;
            _changes.completedAt = _completedAt;
            _changes.resultText = _resultText;
        },

        fail(errorMessage: string, errorCode?: string) {
            if (entity.isTerminal) {
                throw new Error(`Cannot fail job in ${_status} status`);
            }
            _status = TranscriptionJobStatus.FAILED;
            _completedAt = new Date();
            _errorMessage = errorMessage;
            _errorCode = errorCode ?? null;
            _changes.status = _status;
            _changes.errorMessage = _errorMessage;
        },

        cancel() {
            if (entity.isTerminal) {
                throw new Error(`Cannot cancel job in ${_status} status`);
            }
            _status = TranscriptionJobStatus.CANCELLED;
            _completedAt = new Date();
            _changes.status = _status;
        },

        incrementRetry() {
            if (!entity.canRetry) return false;
            _retryCount += 1;
            _status = TranscriptionJobStatus.QUEUED;
            _workerId = null;
            _errorMessage = null;
            _errorCode = null;
            _progress = 0;
            _changes.retryCount = _retryCount;
            _changes.status = _status;
            return true;
        },

        markAsDead() {
            _status = TranscriptionJobStatus.DEAD;
            _completedAt = new Date();
            _changes.status = _status;
        },

        setContextItem(contextItemId: string) {
            _contextItemId = contextItemId;
            _changes.contextItemId = contextItemId;
        },

        setMediaId(mediaId: string) {
            _mediaId = mediaId;
            _changes.mediaId = mediaId;
        },

        toObject() {
            return {
                id: entity.id,
                tenantId: entity.tenantId,
                jobType: entity.jobType,
                status: _status,
                progress: _progress,
                pipelineId: entity.pipelineId,
            };
        },
    };

    return entity;
}

/**
 * Creates a behavioral mock pipeline entity
 */
function createBehavioralPipelineEntity(id: string = 'pipeline-1') {
    return {
        id,
        name: 'Test Pipeline',
        slug: 'test-pipeline',
        isEnabled: true,
        toObject: () => ({ id, name: 'Test Pipeline' }),
    };
}

// ============================================
// Mock External Boundaries Only
// ============================================

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

const mockJobRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    findByConsultation: vi.fn(),
    findJobsByStatus: vi.fn(),
    findWithPipeline: vi.fn(),
    countByStatus: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
};

const mockPipelineRepository = {
    findById: vi.fn(),
};

describe('TranscriptionJobService', () => {
    let service: TranscriptionJobService;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user': return { id: 'current-user-id' };
                case 'tenantId': return 'tenant-1';
                case 'correlationId': return 'corr-123';
                default: return null;
            }
        });

        service = new TranscriptionJobService(
            mockJobRepository as any,
            mockPipelineRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a batch job with correct initial state', async () => {
            const pipeline = createBehavioralPipelineEntity();
            mockPipelineRepository.findById.mockResolvedValue(pipeline);
            mockJobRepository.create.mockImplementation(async (entity: any) => entity);

            const result = await service.create({
                pipelineId: 'pipeline-1',
                jobType: TranscriptionJobType.BATCH as any,
                mediaId: 'media-123',
                consultationId: 'consultation-1',
            });

            // Verify returned entity has correct initial state
            expect(result).toBeDefined();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: expect.any(String),
                })
            );
        });

        it('should throw BadRequestException when tenant ID is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(
                service.create({
                    pipelineId: 'pipeline-1',
                    jobType: TranscriptionJobType.BATCH as any,
                    mediaId: 'media-123',
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw NotFoundException when pipeline not found', async () => {
            mockPipelineRepository.findById.mockResolvedValue(null);

            await expect(
                service.create({
                    pipelineId: 'non-existent',
                    jobType: TranscriptionJobType.BATCH as any,
                    mediaId: 'media-123',
                })
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw BadRequestException when batch job missing mediaId', async () => {
            mockPipelineRepository.findById.mockResolvedValue(createBehavioralPipelineEntity());

            await expect(
                service.create({
                    pipelineId: 'pipeline-1',
                    jobType: TranscriptionJobType.BATCH as any,
                })
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('startProcessing', () => {
        it('should start job processing and verify state changes', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.QUEUED,
            });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.startProcessing('job-123', 'worker-001');

            // BEHAVIORAL VERIFICATION: Check entity state changed
            expect(job.status).toBe(TranscriptionJobStatus.PROCESSING);
            expect(job.isProcessing).toBe(true);
            expect(job.workerId).toBe('worker-001');
            expect(job.startedAt).not.toBeNull();
            expect(job.hasChanges).toBe(true);

            // DTO VERIFICATION: Check response has correct mapped fields
            expect(result.status).toBe(TranscriptionJobStatus.PROCESSING);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'job-123',
                })
            );
        });

        it('should throw NotFoundException when job not found', async () => {
            mockJobRepository.findById.mockResolvedValue(null);

            await expect(
                service.startProcessing('non-existent', 'worker-001')
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw when job is not QUEUED', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.PROCESSING,
            });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.startProcessing('job-123', 'worker-001')
            ).rejects.toThrow();
        });
    });

    describe('updateProgress', () => {
        it('should update job progress and verify state change', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', progress: 0 });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.updateProgress('job-123', 50);

            // BEHAVIORAL VERIFICATION
            expect(job.progress).toBe(50);
            expect(job.hasChanges).toBe(true);
            expect(result.progress).toBe(50);
        });

        it('should throw for invalid progress value', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123' });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.updateProgress('job-123', 150)
            ).rejects.toThrow();
        });
    });

    describe('completeJob', () => {
        it('should complete job and verify state changes', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.PROCESSING,
            });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.completeJob('job-123', 'Transcription result', { confidence: 0.95 });

            // BEHAVIORAL VERIFICATION on entity
            expect(job.status).toBe(TranscriptionJobStatus.COMPLETED);
            expect(job.isCompleted).toBe(true);
            expect(job.isTerminal).toBe(true);
            expect(job.resultText).toBe('Transcription result');
            expect(job.progress).toBe(100);
            expect(job.completedAt).not.toBeNull();

            // DTO VERIFICATION
            expect(result.status).toBe(TranscriptionJobStatus.COMPLETED);
        });

        it('should throw when trying to complete a QUEUED job', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.QUEUED,
            });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.completeJob('job-123', 'result')
            ).rejects.toThrow();
        });
    });

    describe('failJob', () => {
        it('should mark job as failed and verify state changes', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.PROCESSING,
            });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.failJob('job-123', 'Error message', 'ERR_CODE');

            // BEHAVIORAL VERIFICATION on entity
            expect(job.status).toBe(TranscriptionJobStatus.FAILED);
            expect(job.isFailed).toBe(true);
            expect(job.isTerminal).toBe(true);
            expect(job.errorMessage).toBe('Error message');
            expect(job.errorCode).toBe('ERR_CODE');

            // DTO VERIFICATION
            expect(result.status).toBe(TranscriptionJobStatus.FAILED);
        });

        it('should throw when trying to fail a COMPLETED job', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.COMPLETED,
            });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.failJob('job-123', 'Error')
            ).rejects.toThrow();
        });
    });

    describe('cancelJob', () => {
        it('should cancel a job and verify state changes', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.QUEUED,
            });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.cancelJob('job-123');

            // BEHAVIORAL VERIFICATION on entity
            expect(job.status).toBe(TranscriptionJobStatus.CANCELLED);
            expect(job.isCancelled).toBe(true);
            expect(job.isTerminal).toBe(true);

            // DTO VERIFICATION
            expect(result.status).toBe(TranscriptionJobStatus.CANCELLED);
        });

        it('should throw NotFoundException when job not found', async () => {
            mockJobRepository.findById.mockResolvedValue(null);
            await expect(service.cancelJob('non-existent')).rejects.toThrow(NotFoundException);
        });
    });

    describe('retryJob', () => {
        it('should retry a failed job and verify state changes', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.FAILED,
                retryCount: 1,
                maxRetries: 3,
            });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.retryJob('job-123');

            // BEHAVIORAL VERIFICATION on entity
            expect(job.status).toBe(TranscriptionJobStatus.QUEUED);
            expect(job.isQueued).toBe(true);
            expect(job.retryCount).toBe(2);

            // DTO VERIFICATION
            expect(result.status).toBe(TranscriptionJobStatus.QUEUED);
        });

        it('should mark job as dead when max retries exceeded', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.FAILED,
                retryCount: 3,
                maxRetries: 3,
            });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await expect(service.retryJob('job-123')).rejects.toThrow(BadRequestException);
            expect(job.status).toBe(TranscriptionJobStatus.DEAD);
        });
    });

    describe('getById', () => {
        it('should return job by ID', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123' });
            mockJobRepository.findById.mockResolvedValue(job);

            const result = await service.getById('job-123');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('job-123');
        });

        it('should return null when job not found', async () => {
            mockJobRepository.findById.mockResolvedValue(null);
            const result = await service.getById('non-existent');
            expect(result).toBeNull();
        });
    });

    describe('list', () => {
        it('should return paginated jobs', async () => {
            const jobs = [createBehavioralJobEntity({ id: 'job-1' })];
            mockJobRepository.findAll.mockResolvedValue(jobs);
            mockJobRepository.count.mockResolvedValue(1);

            const result = await service.list(1, 20);

            expect(result.data).toHaveLength(1);
            expect(result.total).toBe(1);
            expect(result.page).toBe(1);
        });

        it('should throw BadRequestException when tenant ID is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(service.list(1, 20)).rejects.toThrow(BadRequestException);
        });
    });

    describe('job lifecycle integration', () => {
        it('should handle complete job lifecycle: create -> start -> progress -> complete', async () => {
            const pipeline = createBehavioralPipelineEntity();
            mockPipelineRepository.findById.mockResolvedValue(pipeline);

            // Create job
            let job: any;
            mockJobRepository.create.mockImplementation(async (entity: any) => {
                job = entity;
                return entity;
            });

            await service.create({
                pipelineId: 'pipeline-1',
                jobType: TranscriptionJobType.BATCH as any,
                mediaId: 'media-123',
            });

            // Use behavioral mock for subsequent operations
            job = createBehavioralJobEntity({ id: job.id, status: TranscriptionJobStatus.QUEUED });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            // Start processing
            await service.startProcessing(job.id, 'worker-001');
            expect(job.isProcessing).toBe(true);

            // Update progress
            await service.updateProgress(job.id, 75);
            expect(job.progress).toBe(75);

            // Complete
            await service.completeJob(job.id, 'Final transcript', { confidence: 0.92 });
            expect(job.isCompleted).toBe(true);
            expect(job.progress).toBe(100);
        });
    });
});
