import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

const createMockJobService = () => ({
    create: vi.fn(),
    createBatchJob: vi.fn(),
    createStreamingJob: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    getStatusCounts: vi.fn(),
    getByConsultation: vi.fn(),
    getByStatus: vi.fn(),
    cancelJob: vi.fn(),
    retryJob: vi.fn(),
});

const createMockRealtimeService = () => ({
    createAndStream: vi.fn(),
    subscribeToJob: vi.fn(),
});

const createMockSessionService = () => ({
    checkAvailability: vi.fn(),
    createSession: vi.fn(),
    removeSession: vi.fn(),
});

const createMockCls = () => ({
    get: vi.fn().mockReturnValue({ id: 'user-1', tenantId: 'tenant-1' }),
});

const createMockS3Service = () => ({
    putFile: vi.fn(),
});

describe('TranscriptionJobController', () => {
    let controller: TranscriptionJobController;
    let mockJobService: ReturnType<typeof createMockJobService>;
    let mockRealtimeService: ReturnType<typeof createMockRealtimeService>;
    let mockSessionService: ReturnType<typeof createMockSessionService>;
    let mockCls: ReturnType<typeof createMockCls>;
    let mockS3Service: ReturnType<typeof createMockS3Service>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockJobService = createMockJobService();
        mockRealtimeService = createMockRealtimeService();
        mockSessionService = createMockSessionService();
        mockCls = createMockCls();
        mockS3Service = createMockS3Service();
        controller = new TranscriptionJobController(
            mockJobService as any,
            mockRealtimeService as any,
            mockSessionService as any,
            mockCls as any,
            mockS3Service as any,
        );
    });

    describe('POST / (create job)', () => {
        it('should delegate to jobService.create', async () => {
            const jobResponse = { id: 'job-1', status: 'QUEUED', pipelineId: 'pipe-1' };
            mockJobService.create.mockResolvedValue(jobResponse);

            const result = await controller.create({ jobType: 'BATCH', pipelineId: 'pipe-1' });

            expect(mockJobService.create).toHaveBeenCalledWith({ jobType: 'BATCH', pipelineId: 'pipe-1' });
            expect(result).toEqual(jobResponse);
        });
    });

    describe('POST /batch (create batch job)', () => {
        it('should delegate to jobService.createBatchJob', async () => {
            const jobResponse = { id: 'job-2', status: 'QUEUED' };
            mockJobService.createBatchJob.mockResolvedValue(jobResponse);

            const result = await controller.createBatch({ pipelineId: 'pipe-1', mediaId: 'media-1' });

            expect(mockJobService.createBatchJob).toHaveBeenCalledWith({ pipelineId: 'pipe-1', mediaId: 'media-1' });
            expect(result).toEqual(jobResponse);
        });
    });

    describe('POST /streaming (create streaming job)', () => {
        it('should delegate to jobService.createStreamingJob', async () => {
            const jobResponse = { id: 'job-3', status: 'QUEUED' };
            mockJobService.createStreamingJob.mockResolvedValue(jobResponse);

            const result = await controller.createStreaming({ pipelineId: 'pipe-1' });

            expect(mockJobService.createStreamingJob).toHaveBeenCalledWith({ pipelineId: 'pipe-1' });
            expect(result).toEqual(jobResponse);
        });
    });

    describe('GET /stats', () => {
        it('should return job status counts', async () => {
            const stats = { queued: 5, processing: 2, completed: 10, failed: 1, cancelled: 0, dead: 0 };
            mockJobService.getStatusCounts.mockResolvedValue(stats);

            const result = await controller.getStats();

            expect(mockJobService.getStatusCounts).toHaveBeenCalled();
            expect(result).toEqual(stats);
        });
    });

    describe('GET /consultation/:consultationId', () => {
        it('should return jobs by consultation', async () => {
            const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
            mockJobService.getByConsultation.mockResolvedValue(jobs);

            const result = await controller.getByConsultation('consult-1');

            expect(mockJobService.getByConsultation).toHaveBeenCalledWith('consult-1');
            expect(result).toEqual(jobs);
        });
    });

    describe('GET /:id', () => {
        it('should return a job by ID', async () => {
            const job = { id: 'job-1', status: 'COMPLETED' };
            mockJobService.getById.mockResolvedValue(job);

            const result = await controller.getById('job-1');

            expect(mockJobService.getById).toHaveBeenCalledWith('job-1');
            expect(result).toEqual(job);
        });

        it('should throw NotFoundException when job not found', async () => {
            mockJobService.getById.mockResolvedValue(null);

            await expect(controller.getById('missing')).rejects.toThrow('not found');
        });
    });

    describe('GET / (list)', () => {
        it('should return paginated job list', async () => {
            const paginated = { data: [], total: 0, page: 1, limit: 20, totalPages: 0 };
            mockJobService.list.mockResolvedValue(paginated);

            const result = await controller.list(1, 20);

            expect(mockJobService.list).toHaveBeenCalledWith(1, 20);
            expect(result).toEqual(paginated);
        });
    });

    describe('GET /:id/stream (SSE)', () => {
        it('should return an Observable from realtime service', () => {
            const events$ = of({ data: '{}' });
            mockRealtimeService.subscribeToJob.mockReturnValue(events$);

            const result = controller.streamJob('job-1');

            expect(mockRealtimeService.subscribeToJob).toHaveBeenCalledWith('job-1');
            expect(result).toBeInstanceOf(Observable);
        });

        it('should throw for empty job ID', () => {
            expect(() => controller.streamJob('   ')).toThrow('valid transcription job ID is required');
            expect(mockRealtimeService.subscribeToJob).not.toHaveBeenCalled();
        });
    });

    describe('POST /stream/session', () => {
        it('should create a streaming session with generated sessionId', async () => {
            const sessionStatus = {
                sessionId: 'sess-1',
                status: 'active',
                maxConcurrent: 5,
                currentActive: 1,
            };
            mockSessionService.createSession.mockResolvedValue(sessionStatus);

            const result = await controller.createStreamSession({
                pipelineId: 'pipe-1',
            });

            expect(mockSessionService.createSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    pipelineId: 'pipe-1',
                    tenantId: 'tenant-1',
                }),
            );
            expect(result).toMatchObject({
                sessionId: expect.any(String),
                wsUrl: '/ws/stt-v2/stream',
                maxConcurrent: 5,
                currentActive: 1,
            });
        });

        it('should throw ServiceUnavailableException when STT at capacity', async () => {
            mockSessionService.createSession.mockResolvedValue(null);

            await expect(
                controller.createStreamSession({ pipelineId: 'pipe-1' }),
            ).rejects.toThrow();
        });
    });

    describe('DELETE /stream/session/:sessionId', () => {
        it('should close a streaming session', async () => {
            mockSessionService.removeSession.mockResolvedValue(undefined);

            await controller.closeStreamSession('sess-1');

            expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-1');
        });
    });

    describe('POST /:id/cancel', () => {
        it('should cancel a job', async () => {
            const cancelled = { id: 'job-1', status: 'CANCELLED' };
            mockJobService.cancelJob.mockResolvedValue(cancelled);

            const result = await controller.cancel('job-1');

            expect(mockJobService.cancelJob).toHaveBeenCalledWith('job-1');
            expect(result).toEqual(cancelled);
        });
    });

    describe('POST /:id/retry', () => {
        it('should retry a failed job', async () => {
            const retried = { id: 'job-1', status: 'QUEUED' };
            mockJobService.retryJob.mockResolvedValue(retried);

            const result = await controller.retry('job-1');

            expect(mockJobService.retryJob).toHaveBeenCalledWith('job-1');
            expect(result).toEqual(retried);
        });
    });
});
