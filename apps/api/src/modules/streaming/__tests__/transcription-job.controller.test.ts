import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateStreamSessionRequest, TranscribeFileRequest } from '../dto';
import { TranscriptionJobController } from '../transcription-job.controller';
import {
    TENANT_OWNED_RESOURCE_KEY,
    type TenantOwnedResourceOptions,
} from '../../../common/tenant-owned-resource.decorator';

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
    dispatchDramatiqJob: vi.fn(),
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

const createMockTenantBucketService = () => ({
    getBucketBySlug: vi.fn(),
    getBucketByName: vi.fn(),
});

const createMockPipelineService = () => ({
    // Default: pipeline exists and belongs to caller's tenant.
    getById: vi.fn().mockImplementation(async (id: string) => ({
        id,
        tenantId: 'tenant-1',
        name: 'Default Pipeline',
        slug: id,
    })),
});

const createMockStreamTicketService = () => ({
    issueTicket: vi.fn().mockResolvedValue({
        ticket: 'minted-ticket-1',
        expiresAt: Date.now() + 30_000,
        scope: 'stt_session:placeholder',
    }),
    consumeTicket: vi.fn(),
});

// TASK-310 W7.A.9 (AC-3): the controller now binds on session create and
// clears on close. Tests stub the binding so we can assert the dependency
// is invoked (and used in the new annotation contract).
const createMockStreamSessionTenantBinding = () => ({
    bind: vi.fn().mockResolvedValue(undefined),
    lookup: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
});

describe('TranscriptionJobController', () => {
    let controller: TranscriptionJobController;
    let mockJobService: ReturnType<typeof createMockJobService>;
    let mockRealtimeService: ReturnType<typeof createMockRealtimeService>;
    let mockSessionService: ReturnType<typeof createMockSessionService>;
    let mockCls: ReturnType<typeof createMockCls>;
    let mockS3Service: ReturnType<typeof createMockS3Service>;
    let mockTenantBucketService: ReturnType<typeof createMockTenantBucketService>;
    let mockPipelineService: ReturnType<typeof createMockPipelineService>;
    let mockStreamTicketService: ReturnType<typeof createMockStreamTicketService>;
    let mockStreamSessionTenantBinding: ReturnType<typeof createMockStreamSessionTenantBinding>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockJobService = createMockJobService();
        mockRealtimeService = createMockRealtimeService();
        mockSessionService = createMockSessionService();
        mockCls = createMockCls();
        mockS3Service = createMockS3Service();
        mockTenantBucketService = createMockTenantBucketService();
        mockPipelineService = createMockPipelineService();
        mockStreamTicketService = createMockStreamTicketService();
        mockStreamSessionTenantBinding = createMockStreamSessionTenantBinding();
        controller = new TranscriptionJobController(
            mockJobService as any,
            mockRealtimeService as any,
            mockSessionService as any,
            mockCls as any,
            mockS3Service as any,
            mockTenantBucketService as any,
            mockPipelineService as any,
            mockStreamTicketService as any,
            mockStreamSessionTenantBinding as any,
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
            } as any);

            expect(mockSessionService.createSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    pipelineId: 'pipe-1',
                    tenantId: 'tenant-1',
                    userId: 'user-1',
                }),
            );
            expect(result).toMatchObject({
                sessionId: expect.any(String),
                wsUrl: '/ws/stt-v2/stream',
                maxConcurrent: 5,
                currentActive: 1,
            });
        });

        // TASK-298 D-2 — cross-tenant pipelineId guard.
        it('throws NotFoundException when pipelineId is not in caller tenant (D-2)', async () => {
            mockPipelineService.getById.mockResolvedValueOnce(null);

            await expect(
                controller.createStreamSession({ pipelineId: 'pipe-foreign' } as any),
            ).rejects.toThrow(/Pipeline pipe-foreign not found/);
            expect(mockSessionService.createSession).not.toHaveBeenCalled();
        });

        // TASK-298 D-1 — ticket minting.
        it('mints a stream ticket scoped to stt_session:<sessionId> and returns it (D-1)', async () => {
            mockSessionService.createSession.mockResolvedValue({
                sessionId: 'sess-mint',
                status: 'active',
                maxConcurrent: 5,
                currentActive: 1,
                voiceProfileSeeded: true,
            });

            const result = await controller.createStreamSession({ pipelineId: 'pipe-1' } as any);

            expect(mockStreamTicketService.issueTicket).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    tenantId: 'tenant-1',
                    scope: 'stt_session:sess-mint',
                }),
            );
            expect(result).toMatchObject({
                ticket: 'minted-ticket-1',
                ticketExpiresAt: expect.any(Number),
                voiceProfileSeeded: true,
            });
        });

        it('should resolve and forward tenant audioBucketName when available', async () => {
            mockTenantBucketService.getBucketBySlug.mockResolvedValue({
                id: 'b-1',
                name: 'hope-audio-arcaai',
                slug: 'audio',
            });
            mockSessionService.createSession.mockResolvedValue({
                sessionId: 'sess-1',
                status: 'active',
                maxConcurrent: 5,
                currentActive: 1,
            });

            await controller.createStreamSession({ pipelineId: 'pipe-1' });

            expect(mockTenantBucketService.getBucketBySlug).toHaveBeenCalledWith('audio');
            expect(mockSessionService.createSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    audioBucketName: 'hope-audio-arcaai',
                }),
            );
        });

        it('omits audioBucketName when tenant bucket lookup throws', async () => {
            mockTenantBucketService.getBucketBySlug.mockRejectedValue(new Error('boom'));
            mockSessionService.createSession.mockResolvedValue({
                sessionId: 'sess-1',
                status: 'active',
                maxConcurrent: 5,
                currentActive: 1,
            });

            await controller.createStreamSession({ pipelineId: 'pipe-1' });

            const arg = mockSessionService.createSession.mock.calls[0][0];
            expect(arg.audioBucketName).toBeUndefined();
        });

        it('should throw ServiceUnavailableException when STT at capacity', async () => {
            mockSessionService.createSession.mockResolvedValue(null);

            await expect(
                controller.createStreamSession({ pipelineId: 'pipe-1' } as any),
            ).rejects.toThrow();
        });
    });

    // =========================================================================
    // TASK-298 D-18 — refresh-ticket endpoint
    // =========================================================================
    describe('POST /stream/session/:sessionId/refresh-ticket (D-18)', () => {
        it('mints a new ticket scoped to the existing session', async () => {
            mockStreamTicketService.issueTicket.mockResolvedValueOnce({
                ticket: 'fresh-ticket',
                expiresAt: 1_700_000_000_000,
                scope: 'stt_session:sess-refresh',
            });

            const result = await controller.refreshStreamTicket('sess-refresh');

            expect(mockStreamTicketService.issueTicket).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    tenantId: 'tenant-1',
                    scope: 'stt_session:sess-refresh',
                }),
            );
            expect(result).toEqual({ ticket: 'fresh-ticket', ticketExpiresAt: 1_700_000_000_000 });
        });

        it('rejects empty sessionId', async () => {
            await expect(controller.refreshStreamTicket('   ')).rejects.toThrow(/sessionId is required/);
        });
    });

    // =========================================================================
    // TASK-298 D-19 — pipelineId shape validation
    // =========================================================================
    describe('CreateStreamSessionRequest.pipelineId shape validation (D-19)', () => {
        const validPipelineIds = [
            'general-consult',
            'cardio2',
            'a',
            'f47ac10b-58cc-4372-a567-0e02b2c3d479', // UUID
            'F47AC10B-58CC-4372-A567-0E02B2C3D479', // upper UUID
            'p-1',
        ];
        const invalidPipelineIds = [
            '../../etc/passwd',
            'pipe; DROP TABLE users',
            "1' OR '1'='1",
            'spaces here',
            '',
            '-leading-dash',
        ];

        for (const id of validPipelineIds) {
            it(`accepts valid pipelineId ${JSON.stringify(id)}`, async () => {
                const dto = plainToInstance(CreateStreamSessionRequest, { pipelineId: id });
                const errors = await validate(dto);
                expect(errors).toHaveLength(0);
            });
        }

        for (const id of invalidPipelineIds) {
            it(`rejects invalid pipelineId ${JSON.stringify(id)}`, async () => {
                const dto = plainToInstance(CreateStreamSessionRequest, { pipelineId: id });
                const errors = await validate(dto);
                expect(errors.length).toBeGreaterThan(0);
            });
        }
    });

    describe('TranscribeFileRequest.pipelineId shape validation (D-19)', () => {
        it('rejects pipelineId with path traversal', async () => {
            const dto = plainToInstance(TranscribeFileRequest, { pipelineId: '../bad' });
            const errors = await validate(dto);
            expect(errors.length).toBeGreaterThan(0);
        });

        it('accepts a UUID pipelineId', async () => {
            const dto = plainToInstance(TranscribeFileRequest, {
                pipelineId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            });
            const errors = await validate(dto);
            expect(errors).toHaveLength(0);
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

    // ------------------------------------------------------------------------
    // TASK-307 W3.8 — every transcription-job-by-id handler must carry
    // @TenantOwnedResource so the global interceptor 404s cross-tenant probes
    // (AC-12). Closes audit D-3.
    // ------------------------------------------------------------------------
    describe('TASK-307 W3.8 — @TenantOwnedResource metadata', () => {
        const meta = (m: keyof TranscriptionJobController): TenantOwnedResourceOptions | undefined =>
            Reflect.getMetadata(
                TENANT_OWNED_RESOURCE_KEY,
                TranscriptionJobController.prototype[m] as object,
            ) as TenantOwnedResourceOptions | undefined;

        const expected = { modelName: 'TranscriptionJob', paramName: 'id' };

        it('getById is annotated', () => {
            expect(meta('getById')).toEqual(expected);
        });

        it('cancel is annotated', () => {
            expect(meta('cancel')).toEqual(expected);
        });

        it('retry is annotated', () => {
            expect(meta('retry')).toEqual(expected);
        });

        it('streamJob is annotated', () => {
            expect(meta('streamJob')).toEqual(expected);
        });

        it('list / create / createBatch / createStreaming / transcribeFile / getStats / getByStatus / getByConsultation / createStreamSession / refreshStreamTicket are NOT annotated (no :id route param)', () => {
            // Bulk negative — they either have no :id, or have a non-job id (sessionId / consultationId).
            // Service-layer tenant filtering covers them via the W5.1 Prisma extension.
            expect(meta('list')).toBeUndefined();
            expect(meta('create')).toBeUndefined();
            expect(meta('createBatch')).toBeUndefined();
            expect(meta('createStreaming')).toBeUndefined();
            expect(meta('transcribeFile')).toBeUndefined();
            expect(meta('getStats')).toBeUndefined();
            expect(meta('getByStatus')).toBeUndefined();
            expect(meta('getByConsultation')).toBeUndefined();
            expect(meta('createStreamSession')).toBeUndefined();
            expect(meta('refreshStreamTicket')).toBeUndefined();
        });

        // TASK-310 W7.A.9 (AC-3) — closeStreamSession IS now annotated with
        // the new `StreamSession` resolver branch.
        it('closeStreamSession IS annotated with {modelName: StreamSession, paramName: sessionId, lookup: "session"} (TASK-310 W7.A.9)', () => {
            expect(meta('closeStreamSession')).toEqual({
                modelName: 'StreamSession',
                paramName: 'sessionId',
                lookup: 'session',
            });
        });
    });

    // ------------------------------------------------------------------------
    // TASK-310 W7.A.9 (AC-3) — createStreamSession binds sessionId → tenantId
    // in the gateway-side `StreamSessionTenantBindingService` so the
    // interceptor can 404 cross-tenant probes on closeStreamSession.
    // closeStreamSession clears the binding after the downstream remove
    // succeeds.
    // ------------------------------------------------------------------------
    describe('TASK-310 W7.A.9 — StreamSessionTenantBindingService integration', () => {
        it('createStreamSession binds the returned sessionId to the caller tenant', async () => {
            mockSessionService.createSession.mockResolvedValueOnce({
                sessionId: 'sess-xyz',
                status: 'ACTIVE',
                maxConcurrent: 4,
                currentActive: 1,
            });

            await controller.createStreamSession({ pipelineId: 'pipeline-1' } as CreateStreamSessionRequest);

            expect(mockStreamSessionTenantBinding.bind).toHaveBeenCalledWith('sess-xyz', 'tenant-1');
        });

        it('closeStreamSession clears the binding after a successful downstream remove', async () => {
            mockSessionService.removeSession.mockResolvedValueOnce(undefined);

            await controller.closeStreamSession('sess-xyz');

            expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-xyz');
            expect(mockStreamSessionTenantBinding.clear).toHaveBeenCalledWith('sess-xyz');
        });
    });
});
