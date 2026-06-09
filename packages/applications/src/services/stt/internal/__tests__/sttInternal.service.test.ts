/**
 * SttInternalService Unit Tests
 *
 * Tests for the SttInternalService that handles internal STT-v2 service communication.
 *
 * TESTING APPROACH:
 * - Uses behavioral mock entities that simulate real entity behavior
 * - Only mocks external boundaries: repositories (I/O) and event emitter (side effects)
 * - Verifies actual state changes through behavioral mocks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SttInternalService } from '../sttInternal.service';

// Enum constants
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
// ============================================

/**
 * Creates a BEHAVIORAL mock TranscriptionJobEntity
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
    workerId?: string | null;
    createdBy?: string | null;
} = {}) {
    // Internal mutable state
    let _status = overrides.status ?? TranscriptionJobStatus.QUEUED;
    let _progress = overrides.progress ?? 0;
    let _workerId = overrides.workerId ?? null;
    let _startedAt: Date | null = null;
    let _completedAt: Date | null = null;
    let _resultText: string | null = null;
    let _resultMetadata: any = null;
    let _errorMessage: string | null = null;
    let _errorCode: string | null = null;
    let _contextItemId = 'contextItemId' in overrides ? overrides.contextItemId : null;
    let _mediaId = 'mediaId' in overrides ? overrides.mediaId : 'media-1';
    const _changes: Record<string, any> = {};

    const entity = {
        id: overrides.id ?? 'job-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        jobType: overrides.jobType ?? TranscriptionJobType.BATCH,
        consultationId: 'consultationId' in overrides ? overrides.consultationId : 'consultation-1',
        pipelineId: overrides.pipelineId ?? 'pipeline-1',
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
        get contextItemId() { return _contextItemId; },
        get mediaId() { return _mediaId; },
        set mediaId(value: string) { _mediaId = value; _changes.mediaId = value; },
        get changes() { return _changes; },
        get hasChanges() { return Object.keys(_changes).length > 0; },

        // Status helpers
        get isQueued() { return _status === TranscriptionJobStatus.QUEUED; },
        get isProcessing() { return _status === TranscriptionJobStatus.PROCESSING; },
        get isCompleted() { return _status === TranscriptionJobStatus.COMPLETED; },
        get isFailed() { return _status === TranscriptionJobStatus.FAILED; },
        get isTerminal() {
            return _status === TranscriptionJobStatus.COMPLETED ||
                   _status === TranscriptionJobStatus.FAILED ||
                   _status === TranscriptionJobStatus.CANCELLED ||
                   _status === TranscriptionJobStatus.DEAD;
        },

        // BEHAVIORAL methods
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
                status: _status,
                progress: _progress,
            };
        },
    };

    return entity;
}

/**
 * Creates a mock ContextItemEntity
 */
function createMockContextItemEntity(overrides: {
    id?: string;
    tenantId?: string;
    consultationId?: string;
} = {}) {
    return {
        id: overrides.id ?? 'context-item-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        consultationId: overrides.consultationId ?? 'consultation-1',
        toObject: vi.fn().mockReturnValue({ id: overrides.id ?? 'context-item-1' }),
    };
}

/**
 * Creates a mock MediaEntity
 */
function createMockMediaEntity(overrides: { id?: string } = {}) {
    return {
        id: overrides.id ?? 'media-1',
        toObject: vi.fn().mockReturnValue({ id: overrides.id ?? 'media-1' }),
    };
}

/**
 * Creates a mock AudioRecordingEntity
 */
function createMockAudioRecordingEntity(overrides: { id?: string } = {}) {
    return {
        id: overrides.id ?? 'audio-recording-1',
        toObject: vi.fn().mockReturnValue({ id: overrides.id ?? 'audio-recording-1' }),
    };
}

// ============================================
// Mock External Boundaries
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
    update: vi.fn(),
};

const mockContextItemRepository = {
    findById: vi.fn(),
    create: vi.fn(),
    findAudioRecordings: vi.fn(),
    findTranscripts: vi.fn(),
};

const mockMediaRepository = {
    create: vi.fn(),
};

const mockAudioRecordingRepository = {
    create: vi.fn(),
    getNextSequenceNumber: vi.fn(),
};

describe('SttInternalService', () => {
    let service: SttInternalService;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user': return { id: 'internal-service' };
                case 'tenantId': return 'tenant-1';
                case 'correlationId': return 'corr-123';
                default: return null;
            }
        });

        service = new SttInternalService(
            mockJobRepository as any,
            mockContextItemRepository as any,
            mockMediaRepository as any,
            mockAudioRecordingRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('createTranscript', () => {
        it('should create transcript and update job', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1' });
            const contextItem = createMockContextItemEntity({ id: 'new-context-item-id' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'This is the transcription.',
            });

            expect(result.contextItemId).toBe('new-context-item-id');

            // BEHAVIORAL VERIFICATION
            expect(job.contextItemId).toBe('new-context-item-id');
            expect(job.hasChanges).toBe(true);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-context-item-id',
                })
            );
        });

        it('should throw NotFoundException when job not found', async () => {
            mockJobRepository.findById.mockResolvedValue(null);

            await expect(
                service.createTranscript({
                    jobId: 'non-existent',
                    transcriptText: 'Test',
                })
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw BadRequestException when no consultation ID', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: null });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.createTranscript({
                    jobId: 'job-123',
                    transcriptText: 'Test',
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should use consultationId from request if provided', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: null });
            const contextItem = createMockContextItemEntity({ id: 'new-context-item-id' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Test',
                consultationId: 'override-consultation',
            });

            expect(result.contextItemId).toBe('new-context-item-id');
        });
    });

    describe('startJob', () => {
        it('should start job processing and verify state changes', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.QUEUED,
            });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.startJob('job-123', { workerId: 'worker-001' });

            // BEHAVIORAL VERIFICATION
            expect(job.status).toBe(TranscriptionJobStatus.PROCESSING);
            expect(job.isProcessing).toBe(true);
            expect(job.workerId).toBe('worker-001');
            expect(job.startedAt).not.toBeNull();

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
                service.startJob('non-existent', { workerId: 'worker-001' })
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw when job is not in QUEUED state', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.PROCESSING,
            });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.startJob('job-123', { workerId: 'worker-001' })
            ).rejects.toThrow();
        });
    });

    describe('updateProgress', () => {
        it('should update job progress and verify state change', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', progress: 0 });
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.updateProgress('job-123', { progress: 50 });

            // BEHAVIORAL VERIFICATION
            expect(job.progress).toBe(50);
            expect(job.hasChanges).toBe(true);
        });

        it('should throw NotFoundException when job not found', async () => {
            mockJobRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateProgress('non-existent', { progress: 50 })
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw for invalid progress value', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123' });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.updateProgress('job-123', { progress: 150 })
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

            await service.completeJob('job-123', {
                resultText: 'Transcription result',
                resultMetadata: { confidence: 0.95 },
            });

            // BEHAVIORAL VERIFICATION
            expect(job.status).toBe(TranscriptionJobStatus.COMPLETED);
            expect(job.isCompleted).toBe(true);
            expect(job.resultText).toBe('Transcription result');
            expect(job.progress).toBe(100);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'COMPLETED' }),
                })
            );
        });

        it('should throw NotFoundException when job not found', async () => {
            mockJobRepository.findById.mockResolvedValue(null);

            await expect(
                service.completeJob('non-existent', { resultText: 'Test' })
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw when trying to complete a QUEUED job', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.QUEUED,
            });
            mockJobRepository.findById.mockResolvedValue(job);

            await expect(
                service.completeJob('job-123', { resultText: 'Test' })
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

            await service.failJob('job-123', {
                errorMessage: 'Audio file is corrupted',
                errorCode: 'AUDIO_CORRUPT',
            });

            // BEHAVIORAL VERIFICATION
            expect(job.status).toBe(TranscriptionJobStatus.FAILED);
            expect(job.isFailed).toBe(true);
            expect(job.errorMessage).toBe('Audio file is corrupted');
            expect(job.errorCode).toBe('AUDIO_CORRUPT');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'FAILED' }),
                })
            );
        });

        it('should throw NotFoundException when job not found', async () => {
            mockJobRepository.findById.mockResolvedValue(null);

            await expect(
                service.failJob('non-existent', { errorMessage: 'Error' })
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('createAudioRecord', () => {
        it('should create audio recording successfully', async () => {
            const contextItem = createMockContextItemEntity({ id: 'context-item-1' });
            const media = createMockMediaEntity({ id: 'new-media-id' });
            const audioRecording = createMockAudioRecordingEntity({ id: 'new-audio-recording-id' });

            mockContextItemRepository.findById.mockResolvedValue(contextItem);
            mockMediaRepository.create.mockResolvedValue(media);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(1);
            mockAudioRecordingRepository.create.mockResolvedValue(audioRecording);

            const result = await service.createAudioRecord({
                contextItemId: 'context-item-1',
                storagePath: 'storage/path/recording.wav',
                filename: 'recording.wav',
                fileSizeBytes: 1048576,
                mimeType: 'audio/wav',
            });

            expect(result.audioRecordingId).toBe('new-audio-recording-id');
            expect(result.mediaId).toBe('new-media-id');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-audio-recording-id',
                })
            );
        });

        it('should throw NotFoundException when context item not found', async () => {
            mockContextItemRepository.findById.mockResolvedValue(null);

            await expect(
                service.createAudioRecord({
                    contextItemId: 'non-existent',
                    storagePath: 'path',
                    filename: 'file.wav',
                    fileSizeBytes: 1000,
                    mimeType: 'audio/wav',
                })
            ).rejects.toThrow(NotFoundException);
        });

        it('should update job mediaId when jobId provided', async () => {
            const contextItem = createMockContextItemEntity({ id: 'context-item-1' });
            const media = createMockMediaEntity({ id: 'new-media-id' });
            const audioRecording = createMockAudioRecordingEntity({ id: 'new-audio-recording-id' });
            const job = createBehavioralJobEntity({ id: 'job-123', mediaId: null });

            mockContextItemRepository.findById.mockResolvedValue(contextItem);
            mockMediaRepository.create.mockResolvedValue(media);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(1);
            mockAudioRecordingRepository.create.mockResolvedValue(audioRecording);
            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createAudioRecord({
                contextItemId: 'context-item-1',
                storagePath: 'path',
                filename: 'file.wav',
                fileSizeBytes: 1000,
                mimeType: 'audio/wav',
                jobId: 'job-123',
            });

            // BEHAVIORAL VERIFICATION
            expect(job.mediaId).toBe('new-media-id');
            expect(job.hasChanges).toBe(true);
        });

        it('should use custom sequence number when provided', async () => {
            const contextItem = createMockContextItemEntity({ id: 'context-item-1' });
            const media = createMockMediaEntity({ id: 'new-media-id' });
            const audioRecording = createMockAudioRecordingEntity({ id: 'new-audio-recording-id' });

            mockContextItemRepository.findById.mockResolvedValue(contextItem);
            mockMediaRepository.create.mockResolvedValue(media);
            mockAudioRecordingRepository.create.mockResolvedValue(audioRecording);

            await service.createAudioRecord({
                contextItemId: 'context-item-1',
                storagePath: 'path',
                filename: 'file.wav',
                fileSizeBytes: 1000,
                mimeType: 'audio/wav',
                sequenceNumber: 5,
            });

            expect(mockAudioRecordingRepository.getNextSequenceNumber).not.toHaveBeenCalled();
        });

        // ---------------------------------------------------------------------
        // TASK-331 doc-06 F2 — dual-capture media ids threaded through the writer
        // ---------------------------------------------------------------------

        it('threads rawMediaId/processedMediaId onto the AudioRecording when provided', async () => {
            const contextItem = createMockContextItemEntity({ id: 'context-item-1' });
            const media = createMockMediaEntity({ id: 'new-media-id' });
            const audioRecording = createMockAudioRecordingEntity({ id: 'new-audio-recording-id' });

            mockContextItemRepository.findById.mockResolvedValue(contextItem);
            mockMediaRepository.create.mockResolvedValue(media);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(1);
            mockAudioRecordingRepository.create.mockResolvedValue(audioRecording);

            await service.createAudioRecord({
                contextItemId: 'context-item-1',
                storagePath: 'path',
                filename: 'file.wav',
                fileSizeBytes: 1000,
                mimeType: 'audio/wav',
                rawMediaId: 'raw-media-123',
                processedMediaId: 'processed-media-456',
            });

            // The AudioRecording entity handed to the repository must carry both ids.
            const createdRecording = mockAudioRecordingRepository.create.mock.calls[0][0];
            expect(createdRecording.rawMediaId).toBe('raw-media-123');
            expect(createdRecording.processedMediaId).toBe('processed-media-456');
        });

        it('leaves rawMediaId/processedMediaId null when not provided (regression)', async () => {
            const contextItem = createMockContextItemEntity({ id: 'context-item-1' });
            const media = createMockMediaEntity({ id: 'new-media-id' });
            const audioRecording = createMockAudioRecordingEntity({ id: 'new-audio-recording-id' });

            mockContextItemRepository.findById.mockResolvedValue(contextItem);
            mockMediaRepository.create.mockResolvedValue(media);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(1);
            mockAudioRecordingRepository.create.mockResolvedValue(audioRecording);

            await service.createAudioRecord({
                contextItemId: 'context-item-1',
                storagePath: 'path',
                filename: 'file.wav',
                fileSizeBytes: 1000,
                mimeType: 'audio/wav',
            });

            const createdRecording = mockAudioRecordingRepository.create.mock.calls[0][0];
            expect(createdRecording.rawMediaId).toBeNull();
            expect(createdRecording.processedMediaId).toBeNull();
        });
    });

    // ---------------------------------------------------------------------
    // TASK-334 I-2c — streaming shape: attach by consultationId (resolve the
    // AUDIO_RECORDING container) and use a pre-registered mediaId (the raw /
    // processed Media were already created via createMedia), so NO third Media
    // row is created. This is the parity with the local path's container model.
    // ---------------------------------------------------------------------

    describe('createAudioRecord (streaming consultationId shape)', () => {
        it('resolves/creates the AUDIO_RECORDING container from consultationId and uses the pre-registered mediaId', async () => {
            const container = createMockContextItemEntity({ id: 'audio-container-1', tenantId: 'tenant-1' });
            const audioRecording = createMockAudioRecordingEntity({ id: 'ar-stream-1' });

            mockContextItemRepository.findAudioRecordings.mockResolvedValue([]); // none yet → create
            mockContextItemRepository.create.mockResolvedValue(container);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(1);
            mockAudioRecordingRepository.create.mockResolvedValue(audioRecording);

            const result = await service.createAudioRecord({
                consultationId: 'consultation-1',
                tenantId: 'tenant-1',
                mediaId: 'processed-media-1',
                rawMediaId: 'raw-media-1',
                processedMediaId: 'processed-media-1',
                sampleRate: 16000,
            } as any);

            expect(result.audioRecordingId).toBe('ar-stream-1');
            // Primary = the pre-registered mediaId; NO third Media row created.
            expect(result.mediaId).toBe('processed-media-1');
            expect(mockMediaRepository.create).not.toHaveBeenCalled();

            expect(mockContextItemRepository.findAudioRecordings).toHaveBeenCalledWith('consultation-1');
            const created = mockAudioRecordingRepository.create.mock.calls[0][0];
            expect(created.contextItemId).toBe('audio-container-1');
            expect(created.rawMediaId).toBe('raw-media-1');
            expect(created.processedMediaId).toBe('processed-media-1');
        });

        it('reuses an existing AUDIO_RECORDING container instead of creating a new one', async () => {
            const existing = createMockContextItemEntity({ id: 'existing-container', tenantId: 'tenant-1' });
            const audioRecording = createMockAudioRecordingEntity({ id: 'ar-stream-2' });

            mockContextItemRepository.findAudioRecordings.mockResolvedValue([existing]);
            mockAudioRecordingRepository.getNextSequenceNumber.mockResolvedValue(2);
            mockAudioRecordingRepository.create.mockResolvedValue(audioRecording);

            await service.createAudioRecord({
                consultationId: 'consultation-1',
                tenantId: 'tenant-1',
                mediaId: 'media-x',
            } as any);

            expect(mockContextItemRepository.create).not.toHaveBeenCalled();
            expect(mockAudioRecordingRepository.create.mock.calls[0][0].contextItemId).toBe('existing-container');
        });

        it('throws BadRequestException when neither contextItemId nor consultationId is provided', async () => {
            await expect(
                service.createAudioRecord({ mediaId: 'media-x', tenantId: 'tenant-1' } as any),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws BadRequestException when no mediaId and the storage fields are incomplete', async () => {
            await expect(
                service.createAudioRecord({ consultationId: 'consultation-1', tenantId: 'tenant-1' } as any),
            ).rejects.toThrow(BadRequestException);
            // No container should be created for an invalid request (validate before side effects).
            expect(mockContextItemRepository.create).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // TASK-334 I-2b — standalone Media registration (POST /internal/stt/media).
    // The streaming dual-capture path uploads raw/processed WAVs to storage and
    // needs to turn each storage object into a Media row (to obtain rawMediaId /
    // processedMediaId) BEFORE creating the AudioRecording.
    // =========================================================================

    describe('createMedia', () => {
        it('registers a storage object as a Media row and returns its id', async () => {
            const media = createMockMediaEntity({ id: 'media-xyz' });
            mockMediaRepository.create.mockResolvedValue(media);

            const result = await service.createMedia({
                tenantId: 'tenant-1',
                name: 'session-1-raw.wav',
                uri: 's3://bucket/tenant-1/session-1-raw.wav',
                extension: 'wav',
                mimeType: 'audio/wav',
                size: 2048,
                hash: '',
                createdBy: 'user-123',
            });

            expect(result.id).toBe('media-xyz');

            // The Media handed to the repository carries the storage uri, tenant, and creator.
            const created = mockMediaRepository.create.mock.calls[0][0];
            expect(created.uri).toBe('s3://bucket/tenant-1/session-1-raw.wav');
            expect(created.tenantId).toBe('tenant-1');
            expect(created.createdBy).toBe('user-123');
            expect(created.hash).toBe('');
        });

        it('defaults a missing hash to empty string', async () => {
            const media = createMockMediaEntity({ id: 'media-2' });
            mockMediaRepository.create.mockResolvedValue(media);

            const result = await service.createMedia({
                tenantId: 'tenant-1',
                name: 'x.wav',
                uri: 's3://b/x.wav',
                extension: 'wav',
                mimeType: 'audio/wav',
                size: 1,
            } as any);

            expect(result.id).toBe('media-2');
            expect(mockMediaRepository.create.mock.calls[0][0].hash).toBe('');
        });
    });

    // =========================================================================
    // GAP-1: TranscriptionCreated Pipeline Event Emission
    // =========================================================================

    describe('TranscriptionCreated pipeline event (GAP-1)', () => {
        it('should emit TranscriptionCreated event after creating transcript', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1', tenantId: 'tenant-abc' });
            const contextItem = createMockContextItemEntity({ id: 'ctx-item-001' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Patient reports headache and fever.',
            });

            // Should emit BOTH SysEvent AND pipeline event
            expect(mockEventEmitter.emit).toHaveBeenCalledTimes(2);

            // Verify pipeline event is emitted with correct event name
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'consultation.transcription.created',
                expect.objectContaining({
                    consultationId: 'consultation-1',
                    tenantId: 'tenant-abc',
                    contextItemId: 'ctx-item-001',
                    jobId: 'job-123',
                }),
            );
        });

        it('should include word count in TranscriptionCreated payload', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1' });
            const contextItem = createMockContextItemEntity({ id: 'ctx-item-001' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'one two three four five',
            });

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCall).toBeDefined();
            expect(pipelineCall![1].wordCount).toBe(5);
        });

        it('should default transcriptionSource to "batch" when not provided', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1' });
            const contextItem = createMockContextItemEntity({ id: 'ctx-item-001' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Test transcript',
            });

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCall![1].transcriptionSource).toBe('batch');
        });

        it('should pass transcriptionSource "streaming" when specified', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1' });
            const contextItem = createMockContextItemEntity({ id: 'ctx-item-001' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Test transcript',
                transcriptionSource: 'streaming',
            });

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCall![1].transcriptionSource).toBe('streaming');
        });

        it('should include userId from job.createdBy in pipeline event', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1', createdBy: 'doctor-42' });
            const contextItem = createMockContextItemEntity({ id: 'ctx-item-001' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Test transcript',
            });

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCall![1].userId).toBe('doctor-42');
        });

        it('should include ISO timestamp in pipeline event', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1' });
            const contextItem = createMockContextItemEntity({ id: 'ctx-item-001' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Test transcript',
            });

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCall![1].timestamp).toBeDefined();
            // Verify it's a valid ISO string
            expect(new Date(pipelineCall![1].timestamp).toISOString()).toBe(pipelineCall![1].timestamp);
        });

        it('should NOT emit pipeline event when job not found (throws before reaching emit)', async () => {
            mockJobRepository.findById.mockResolvedValue(null);

            await expect(
                service.createTranscript({ jobId: 'non-existent', transcriptText: 'Test' }),
            ).rejects.toThrow(NotFoundException);

            // No events emitted at all
            expect(mockEventEmitter.emit).not.toHaveBeenCalled();
        });

        it('should handle empty tenantId gracefully', async () => {
            const job = createBehavioralJobEntity({ id: 'job-123', consultationId: 'consultation-1', tenantId: '' });
            const contextItem = createMockContextItemEntity({ id: 'ctx-item-001' });

            mockJobRepository.findById.mockResolvedValue(job);
            mockContextItemRepository.create.mockResolvedValue(contextItem);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Test transcript',
            });

            const pipelineCall = mockEventEmitter.emit.mock.calls.find(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCall![1].tenantId).toBe('');
        });
    });

    describe('internal service workflow integration', () => {
        it('should handle complete transcription workflow', async () => {
            const job = createBehavioralJobEntity({
                id: 'job-123',
                status: TranscriptionJobStatus.QUEUED,
                consultationId: 'consultation-1',
            });

            mockJobRepository.findById.mockResolvedValue(job);
            mockJobRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            // Step 1: Start job
            await service.startJob('job-123', { workerId: 'worker-001' });
            expect(job.isProcessing).toBe(true);

            // Step 2: Update progress
            await service.updateProgress('job-123', { progress: 50 });
            expect(job.progress).toBe(50);

            // Step 3: Complete job
            await service.completeJob('job-123', {
                resultText: 'Final transcription',
                resultMetadata: { confidence: 0.92 },
            });
            expect(job.isCompleted).toBe(true);
            expect(job.progress).toBe(100);

            // Step 4: Create transcript
            const contextItem = createMockContextItemEntity({ id: 'context-item-123' });
            mockContextItemRepository.create.mockResolvedValue(contextItem);

            await service.createTranscript({
                jobId: 'job-123',
                transcriptText: 'Final transcription',
            });
            expect(job.contextItemId).toBe('context-item-123');
        });
    });

    // =========================================================================
    // TASK-342 GAP #1 — streaming finalize persists a TRANSCRIPT with NO jobId.
    // The transcript is keyed directly to the consultation (+ tenant) so the
    // harness auto-draft pipeline triggers after a live consultation.
    // =========================================================================
    describe('createTranscript (no-job streaming path)', () => {
        it('persists a TRANSCRIPT keyed to the consultation without touching the job repo', async () => {
            const contextItem = createMockContextItemEntity({ id: 'stream-ctx-1' });
            mockContextItemRepository.findTranscripts.mockResolvedValue([]);
            mockContextItemRepository.create.mockResolvedValue(contextItem);

            const result = await service.createTranscript({
                consultationId: 'consultation-stream-1',
                tenantId: 'tenant-stream-1',
                transcriptText: 'Live consultation transcript.',
                transcriptionSource: 'streaming',
            });

            expect(result.contextItemId).toBe('stream-ctx-1');
            // No job lookup / update on the streaming path
            expect(mockJobRepository.findById).not.toHaveBeenCalled();
            expect(mockJobRepository.update).not.toHaveBeenCalled();

            const created = mockContextItemRepository.create.mock.calls[0][0];
            expect(created.type).toBe('TRANSCRIPT');
            expect(created.consultationId).toBe('consultation-stream-1');
            expect(created.tenantId).toBe('tenant-stream-1');
        });

        it('emits TranscriptionCreated once with the streaming source and no jobId', async () => {
            const contextItem = createMockContextItemEntity({ id: 'stream-ctx-2' });
            mockContextItemRepository.findTranscripts.mockResolvedValue([]);
            mockContextItemRepository.create.mockResolvedValue(contextItem);

            await service.createTranscript({
                consultationId: 'consultation-stream-2',
                tenantId: 'tenant-stream-2',
                transcriptText: 'one two three',
                transcriptionSource: 'streaming',
            });

            const pipelineCalls = mockEventEmitter.emit.mock.calls.filter(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCalls).toHaveLength(1);
            const payload = pipelineCalls[0][1];
            expect(payload.consultationId).toBe('consultation-stream-2');
            expect(payload.tenantId).toBe('tenant-stream-2');
            expect(payload.contextItemId).toBe('stream-ctx-2');
            expect(payload.transcriptionSource).toBe('streaming');
            expect(payload.jobId).toBeUndefined();
        });

        it('throws BadRequestException when neither jobId nor consultationId is provided', async () => {
            await expect(
                service.createTranscript({
                    tenantId: 'tenant-stream-3',
                    transcriptText: 'orphan transcript',
                } as any),
            ).rejects.toThrow(BadRequestException);
            expect(mockContextItemRepository.create).not.toHaveBeenCalled();
        });

        it('is idempotent — skips create + emit when a transcript already exists for the consultation', async () => {
            const existing = createMockContextItemEntity({ id: 'existing-transcript' });
            mockContextItemRepository.findTranscripts.mockResolvedValue([existing]);

            const result = await service.createTranscript({
                consultationId: 'consultation-stream-4',
                tenantId: 'tenant-stream-4',
                transcriptText: 'duplicate finalize',
                transcriptionSource: 'streaming',
            });

            expect(result.contextItemId).toBe('existing-transcript');
            expect(mockContextItemRepository.create).not.toHaveBeenCalled();
            const pipelineCalls = mockEventEmitter.emit.mock.calls.filter(
                (c: any[]) => c[0] === 'consultation.transcription.created',
            );
            expect(pipelineCalls).toHaveLength(0);
        });
    });
});
