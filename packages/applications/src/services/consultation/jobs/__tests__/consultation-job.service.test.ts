/**
 * ConsultationJobService Unit Tests
 *
 * Tests for the ConsultationJobService that handles async job creation and management
 * for consultation AI processing (pre-summary, summary, NER extraction).
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Queue, Job } from 'bullmq';
import { Observable, Subject } from 'rxjs';
import { MessageEvent } from '@nestjs/common';
import { ConsultationJobService } from '../consultation-job.service';
import { JobQueue } from '@arcaai/domains';
import {
    ConsultationJobStatus,
    GeneratePreSummaryJobPayload,
    GenerateSummaryJobPayload,
    ExtractNerJobPayload,
} from '../dto';

// Mock uuidv7 to return predictable IDs
vi.mock('uuidv7', () => ({
    uuidv7: vi.fn(() => 'test-job-id-123'),
}));

// Mock Queue class
const createMockQueue = () => ({
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
});

// Mock Redis Cache Service
const createMockCacheService = () => ({
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
});

// Mock Redis Subscriber Service
const createMockRedisSubscriber = () => ({
    subscribeToChannel: vi.fn().mockResolvedValue(new Observable(() => {})),
    unsubscribeFromChannel: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
});

describe('ConsultationJobService', () => {
    let service: ConsultationJobService;
    let mockPreSummaryQueue: ReturnType<typeof createMockQueue>;
    let mockSummaryQueue: ReturnType<typeof createMockQueue>;
    let mockComprehensiveSummaryQueue: ReturnType<typeof createMockQueue>;
    let mockNerQueue: ReturnType<typeof createMockQueue>;
    let mockCacheService: ReturnType<typeof createMockCacheService>;
    let mockRedisSubscriber: ReturnType<typeof createMockRedisSubscriber>;

    beforeEach(() => {
        vi.clearAllMocks();

        mockPreSummaryQueue = createMockQueue();
        mockSummaryQueue = createMockQueue();
        mockComprehensiveSummaryQueue = createMockQueue();
        mockNerQueue = createMockQueue();
        mockCacheService = createMockCacheService();
        mockRedisSubscriber = createMockRedisSubscriber();

        service = new ConsultationJobService(
            mockPreSummaryQueue as unknown as Queue,
            mockSummaryQueue as unknown as Queue,
            mockComprehensiveSummaryQueue as unknown as Queue,
            mockNerQueue as unknown as Queue,
            mockCacheService as any,
            mockRedisSubscriber as any,
        );
    });

    // ===========================================================================
    // createPreSummaryJob Tests
    // ===========================================================================

    describe('createPreSummaryJob', () => {
        const validParams = {
            consultationId: 'consultation-123',
            tenantId: 'tenant-1',
            userId: 'user-1',
            request: {
                dnaStyleId: 'style-1',
                caseNoteIds: ['case-1', 'case-2'],
            },
        };

        it('should create a pre-summary job and return JobResponse', async () => {
            const result = await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(result).toEqual({
                jobId: 'test-job-id-123',
                status: 'PENDING',
                sseUrl: '/api/consultations/jobs/test-job-id-123/sse',
                estimatedSeconds: 30,
            });
        });

        it('should add job to pre-summary queue with correct payload', async () => {
            await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    jobId: 'test-job-id-123',
                    consultationId: validParams.consultationId,
                    tenantId: validParams.tenantId,
                    userId: validParams.userId,
                    request: validParams.request,
                    callbackUrl: undefined,
                }),
                expect.objectContaining({
                    jobId: 'test-job-id-123',
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 1000 },
                }),
            );
        });

        it('should store initial job status in Redis', async () => {
            await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:test-job-id-123',
                86400, // 24 hours TTL
                expect.stringContaining('"type":"PRE_SUMMARY"'),
            );
        });

        it('should include callbackUrl when provided', async () => {
            await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
                'https://example.com/callback',
            );

            expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    callbackUrl: 'https://example.com/callback',
                }),
                expect.any(Object),
            );
        });

        it('should work with minimal request (no dnaStyleId or caseNoteIds)', async () => {
            const result = await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                {},
            );

            expect(result.jobId).toBe('test-job-id-123');
            expect(mockPreSummaryQueue.add).toHaveBeenCalled();
        });

        it('should handle empty caseNoteIds array', async () => {
            await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                { caseNoteIds: [] },
            );

            expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    request: { caseNoteIds: [] },
                }),
                expect.any(Object),
            );
        });

        it('should include options in request when provided', async () => {
            const options = { temperature: 0.7, maxTokens: 1000 };

            await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                { options },
            );

            expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    request: { options },
                }),
                expect.any(Object),
            );
        });
    });

    // ===========================================================================
    // createSummaryJob Tests
    // ===========================================================================

    describe('createSummaryJob', () => {
        const validParams = {
            consultationId: 'consultation-123',
            tenantId: 'tenant-1',
            userId: 'user-1',
            request: {
                dnaStyleId: 'style-1',
                template: 'default',
                includeNER: true,
                contextItemIds: ['ctx-1', 'ctx-2'],
            },
        };

        it('should create a summary job and return JobResponse', async () => {
            const result = await service.createSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(result).toEqual({
                jobId: 'test-job-id-123',
                status: 'PENDING',
                sseUrl: '/api/consultations/jobs/test-job-id-123/sse',
                estimatedSeconds: 60,
            });
        });

        it('should add job to summary queue with correct payload', async () => {
            await service.createSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(mockSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    jobId: 'test-job-id-123',
                    consultationId: validParams.consultationId,
                    request: validParams.request,
                }),
                expect.any(Object),
            );
        });

        it('should store initial job status as SUMMARY type', async () => {
            await service.createSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:test-job-id-123',
                86400,
                expect.stringContaining('"type":"SUMMARY"'),
            );
        });

        it('should handle includeNER flag in request', async () => {
            await service.createSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                { includeNER: false },
            );

            expect(mockSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    request: { includeNER: false },
                }),
                expect.any(Object),
            );
        });

        it('should work with empty contextItemIds', async () => {
            await service.createSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                { contextItemIds: [] },
            );

            expect(mockSummaryQueue.add).toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // createNerJob Tests
    // ===========================================================================

    describe('createNerJob', () => {
        const validParams = {
            contextItemId: 'ctx-item-123',
            consultationId: 'consultation-123',
            tenantId: 'tenant-1',
            userId: 'user-1',
        };

        it('should create a NER job and return JobResponse', async () => {
            const result = await service.createNerJob(
                validParams.contextItemId,
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
            );

            expect(result).toEqual({
                jobId: 'test-job-id-123',
                status: 'PENDING',
                sseUrl: '/api/consultations/jobs/test-job-id-123/sse',
                estimatedSeconds: 15,
            });
        });

        it('should add job to NER queue with correct payload', async () => {
            await service.createNerJob(
                validParams.contextItemId,
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
            );

            expect(mockNerQueue.add).toHaveBeenCalledWith(
                'extract',
                expect.objectContaining({
                    jobId: 'test-job-id-123',
                    contextItemId: validParams.contextItemId,
                    consultationId: validParams.consultationId,
                    tenantId: validParams.tenantId,
                    userId: validParams.userId,
                }),
                expect.any(Object),
            );
        });

        it('should store initial job status as NER type', async () => {
            await service.createNerJob(
                validParams.contextItemId,
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
            );

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:test-job-id-123',
                86400,
                expect.stringContaining('"type":"NER"'),
            );
        });

        it('should include callbackUrl when provided', async () => {
            await service.createNerJob(
                validParams.contextItemId,
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                'https://example.com/ner-callback',
            );

            expect(mockNerQueue.add).toHaveBeenCalledWith(
                'extract',
                expect.objectContaining({
                    callbackUrl: 'https://example.com/ner-callback',
                }),
                expect.any(Object),
            );
        });
    });

    // ===========================================================================
    // createComprehensiveSummaryJob Tests
    // ===========================================================================

    describe('createComprehensiveSummaryJob', () => {
        const validParams = {
            consultationId: 'consultation-chain-root',
            tenantId: 'tenant-1',
            userId: 'doctor-A',
            request: {
                dnaStyleId: 'style_DNA_dept_gen',
                template: 'comprehensive',
                includeNER: true,
                includeLabResults: true,
                options: { maxTokens: 4000 },
            },
        };

        it('should create a comprehensive summary job and return JobResponse', async () => {
            const result = await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(result).toEqual({
                jobId: 'test-job-id-123',
                status: 'PENDING',
                sseUrl: '/api/consultations/jobs/test-job-id-123/sse',
                estimatedSeconds: 120, // Longer estimate for cross-chain summaries
            });
        });

        it('should add job to the GenerateComprehensiveSummary queue (not regular Summary queue)', async () => {
            await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            // Must use the comprehensive summary queue, not the regular summary queue
            expect(mockComprehensiveSummaryQueue.add).toHaveBeenCalledTimes(1);
            expect(mockSummaryQueue.add).not.toHaveBeenCalled();
            expect(mockPreSummaryQueue.add).not.toHaveBeenCalled();
            expect(mockNerQueue.add).not.toHaveBeenCalled();
        });

        it('should add job with correct payload structure', async () => {
            await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(mockComprehensiveSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    jobId: 'test-job-id-123',
                    consultationId: 'consultation-chain-root',
                    tenantId: 'tenant-1',
                    userId: 'doctor-A',
                    request: {
                        dnaStyleId: 'style_DNA_dept_gen',
                        template: 'comprehensive',
                        includeNER: true,
                        includeLabResults: true,
                        options: { maxTokens: 4000 },
                    },
                }),
                expect.any(Object),
            );
        });

        it('should use 2 attempts (fewer retries than regular summary which uses 3)', async () => {
            await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            const queueOptions = mockComprehensiveSummaryQueue.add.mock.calls[0][2];
            expect(queueOptions.attempts).toBe(2);
        });

        it('should use exponential backoff with 2s delay', async () => {
            await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            const queueOptions = mockComprehensiveSummaryQueue.add.mock.calls[0][2];
            expect(queueOptions.backoff).toEqual({ type: 'exponential', delay: 2000 });
        });

        it('should store initial job status as COMPREHENSIVE_SUMMARY type', async () => {
            await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:test-job-id-123',
                86400,
                expect.stringContaining('"type":"COMPREHENSIVE_SUMMARY"'),
            );
        });

        it('should store initial status as PENDING with progress 0', async () => {
            await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
            );

            const storedValue = mockCacheService.setex.mock.calls[0][2];
            const parsed = JSON.parse(storedValue);
            expect(parsed.status).toBe('PENDING');
            expect(parsed.progress).toBe(0);
            expect(parsed.consultationId).toBe('consultation-chain-root');
        });

        it('should include callbackUrl when provided', async () => {
            await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
                'https://frontend/callback',
            );

            expect(mockComprehensiveSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    callbackUrl: 'https://frontend/callback',
                }),
                expect.any(Object),
            );
        });

        it('should handle empty request object', async () => {
            const result = await service.createComprehensiveSummaryJob(
                'c1',
                't1',
                'u1',
                {},
            );

            expect(result.jobId).toBe('test-job-id-123');
            expect(result.status).toBe('PENDING');

            const payload = mockComprehensiveSummaryQueue.add.mock.calls[0][1];
            expect(payload.request).toEqual({});
        });

        it('should return 120s estimated time (longer than 60s for regular summaries)', async () => {
            const result = await service.createComprehensiveSummaryJob(
                'c1', 't1', 'u1', {},
            );

            expect(result.estimatedSeconds).toBe(120);
        });
    });

    // ===========================================================================
    // getJobStatus Tests
    // ===========================================================================

    describe('getJobStatus', () => {
        it('should return null when job not found', async () => {
            mockCacheService.get.mockResolvedValue(null);

            const result = await service.getJobStatus('non-existent-job');

            expect(result).toBeNull();
            expect(mockCacheService.get).toHaveBeenCalledWith('consultation_job:non-existent-job');
        });

        it('should return job status when found', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'PRE_SUMMARY',
                status: 'RUNNING',
                consultationId: 'consultation-123',
                progress: 50,
                currentStep: 'Generating pre-summary',
                createdAt: new Date('2026-02-01T10:00:00Z'),
                startedAt: new Date('2026-02-01T10:01:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.getJobStatus('job-123');

            expect(result).not.toBeNull();
            expect(result?.jobId).toBe('job-123');
            expect(result?.type).toBe('PRE_SUMMARY');
            expect(result?.status).toBe('RUNNING');
            expect(result?.progress).toBe(50);
        });

        it('should parse dates correctly from stored JSON', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'COMPLETED',
                consultationId: 'consultation-123',
                progress: 100,
                createdAt: new Date('2026-02-01T10:00:00Z'),
                startedAt: new Date('2026-02-01T10:01:00Z'),
                completedAt: new Date('2026-02-01T10:05:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.getJobStatus('job-123');

            expect(result?.createdAt).toBeInstanceOf(Date);
            expect(result?.startedAt).toBeInstanceOf(Date);
            expect(result?.completedAt).toBeInstanceOf(Date);
        });

        it('should return result when job completed', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'COMPLETED',
                consultationId: 'consultation-123',
                progress: 100,
                result: { contextItemId: 'ctx-1', content: 'Summary text' },
                createdAt: new Date('2026-02-01T10:00:00Z'),
                completedAt: new Date('2026-02-01T10:05:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.getJobStatus('job-123');

            expect(result?.result).toEqual({ contextItemId: 'ctx-1', content: 'Summary text' });
        });

        it('should return error when job failed', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'FAILED',
                contextItemId: 'ctx-123',
                progress: 30,
                error: 'NLP service unavailable',
                createdAt: new Date('2026-02-01T10:00:00Z'),
                completedAt: new Date('2026-02-01T10:02:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.getJobStatus('job-123');

            expect(result?.status).toBe('FAILED');
            expect(result?.error).toBe('NLP service unavailable');
        });
    });

    // ===========================================================================
    // cancelJob Tests
    // ===========================================================================

    describe('cancelJob', () => {
        it('should return false when job not found', async () => {
            mockCacheService.get.mockResolvedValue(null);

            const result = await service.cancelJob('non-existent-job');

            expect(result).toBe(false);
        });

        it('should return false for already COMPLETED job', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'COMPLETED',
                progress: 100,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.cancelJob('job-123');

            expect(result).toBe(false);
            expect(mockSummaryQueue.getJob).not.toHaveBeenCalled();
        });

        it('should return false for already FAILED job', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'FAILED',
                progress: 50,
                error: 'Service error',
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.cancelJob('job-123');

            expect(result).toBe(false);
        });

        it('should return false for already CANCELLED job', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'CANCELLED',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.cancelJob('job-123');

            expect(result).toBe(false);
        });

        it('should cancel PENDING PRE_SUMMARY job successfully', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'PRE_SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const mockJob = {
                getState: vi.fn().mockResolvedValue('waiting'),
                remove: vi.fn().mockResolvedValue(undefined),
            };
            mockPreSummaryQueue.getJob.mockResolvedValue(mockJob);

            const result = await service.cancelJob('job-123');

            expect(result).toBe(true);
            expect(mockPreSummaryQueue.getJob).toHaveBeenCalledWith('job-123');
            expect(mockJob.remove).toHaveBeenCalled();
            expect(mockCacheService.setex).toHaveBeenCalled();
            expect(mockCacheService.publish).toHaveBeenCalled();
        });

        it('should cancel PENDING SUMMARY job successfully', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const mockJob = {
                getState: vi.fn().mockResolvedValue('delayed'),
                remove: vi.fn().mockResolvedValue(undefined),
            };
            mockSummaryQueue.getJob.mockResolvedValue(mockJob);

            const result = await service.cancelJob('job-123');

            expect(result).toBe(true);
            expect(mockSummaryQueue.getJob).toHaveBeenCalledWith('job-123');
            expect(mockJob.remove).toHaveBeenCalled();
        });

        it('should cancel PENDING NER job successfully', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            mockNerQueue.getJob.mockResolvedValue(null);

            const result = await service.cancelJob('job-123');

            expect(result).toBe(true);
            expect(mockNerQueue.getJob).toHaveBeenCalledWith('job-123');
        });

        it('should cancel PENDING COMPREHENSIVE_SUMMARY job successfully', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'COMPREHENSIVE_SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const mockJob = {
                getState: vi.fn().mockResolvedValue('waiting'),
                remove: vi.fn().mockResolvedValue(undefined),
            };
            mockComprehensiveSummaryQueue.getJob.mockResolvedValue(mockJob);

            const result = await service.cancelJob('job-123');

            expect(result).toBe(true);
            expect(mockComprehensiveSummaryQueue.getJob).toHaveBeenCalledWith('job-123');
            expect(mockJob.remove).toHaveBeenCalled();
        });

        it('should cancel RUNNING job (update status but not remove)', async () => {
            const storedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 50,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const mockJob = {
                getState: vi.fn().mockResolvedValue('active'),
                remove: vi.fn().mockResolvedValue(undefined),
            };
            mockSummaryQueue.getJob.mockResolvedValue(mockJob);

            const result = await service.cancelJob('job-123');

            expect(result).toBe(true);
            // Should NOT call remove for active jobs (only waiting/delayed)
            expect(mockJob.remove).not.toHaveBeenCalled();
        });

        it('should return false for unknown job type', async () => {
            const storedStatus = {
                jobId: 'job-123',
                type: 'UNKNOWN_TYPE',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(storedStatus));

            const result = await service.cancelJob('job-123');

            expect(result).toBe(false);
        });
    });

    // ===========================================================================
    // notifyProgress Tests
    // ===========================================================================

    describe('notifyProgress', () => {
        it('should update job status with progress and step', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyProgress('job-123', 50, 'Processing content');

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"status":"RUNNING"'),
            );
            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"progress":50'),
            );
            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"currentStep":"Processing content"'),
            );
        });

        it('should publish progress update to Redis channel', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyProgress('job-123', 75, 'Finalizing');

            expect(mockCacheService.publish).toHaveBeenCalledWith(
                'consultation_job_updates:job-123',
                expect.any(String),
            );
        });

        it('should set startedAt on first progress notification', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyProgress('job-123', 10, 'Starting');

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"startedAt"'),
            );
        });

        it('should preserve existing startedAt on subsequent progress updates', async () => {
            const existingStartedAt = new Date('2026-02-01T10:00:00Z');
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 30,
                startedAt: existingStartedAt,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyProgress('job-123', 60, 'Continuing');

            const setexCall = mockCacheService.setex.mock.calls[0];
            const storedData = JSON.parse(setexCall[2]);
            expect(new Date(storedData.startedAt).toISOString()).toBe(existingStartedAt.toISOString());
        });

        it('should do nothing when job not found', async () => {
            mockCacheService.get.mockResolvedValue(null);

            await service.notifyProgress('non-existent', 50, 'Step');

            expect(mockCacheService.setex).not.toHaveBeenCalled();
            expect(mockCacheService.publish).not.toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // notifyComplete Tests
    // ===========================================================================

    describe('notifyComplete', () => {
        it('should update job status to COMPLETED with result', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 90,
                createdAt: new Date(),
                startedAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            const result = { contextItemId: 'ctx-1', content: 'Generated summary' };
            await service.notifyComplete('job-123', result);

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"status":"COMPLETED"'),
            );
            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"progress":100'),
            );
        });

        it('should set completedAt timestamp', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'RUNNING',
                progress: 70,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyComplete('job-123', { entities: [] });

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"completedAt"'),
            );
        });

        it('should publish completion update to Redis channel', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'PRE_SUMMARY',
                status: 'RUNNING',
                progress: 80,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyComplete('job-123', { content: 'Pre-summary' });

            expect(mockCacheService.publish).toHaveBeenCalledWith(
                'consultation_job_updates:job-123',
                expect.any(String),
            );
        });

        it('should include result in stored status', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 99,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            const result = {
                contextItemId: 'ctx-123',
                content: 'Summary text',
                summaryMeta: {
                    aiModelId: 'gpt-4',
                    processingTimeMs: 5000,
                },
            };
            await service.notifyComplete('job-123', result);

            const setexCall = mockCacheService.setex.mock.calls[0];
            const storedData = JSON.parse(setexCall[2]);
            expect(storedData.result).toEqual(result);
        });

        it('should do nothing when job not found', async () => {
            mockCacheService.get.mockResolvedValue(null);

            await service.notifyComplete('non-existent', { data: 'result' });

            expect(mockCacheService.setex).not.toHaveBeenCalled();
            expect(mockCacheService.publish).not.toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // notifyFailed Tests
    // ===========================================================================

    describe('notifyFailed', () => {
        it('should update job status to FAILED with error message', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 45,
                createdAt: new Date(),
                startedAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyFailed('job-123', 'SMR service timeout');

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"status":"FAILED"'),
            );
            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"error":"SMR service timeout"'),
            );
        });

        it('should set completedAt timestamp on failure', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'RUNNING',
                progress: 30,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyFailed('job-123', 'NLP service error');

            expect(mockCacheService.setex).toHaveBeenCalledWith(
                'consultation_job:job-123',
                86400,
                expect.stringContaining('"completedAt"'),
            );
        });

        it('should publish failure update to Redis channel', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'PRE_SUMMARY',
                status: 'RUNNING',
                progress: 20,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            await service.notifyFailed('job-123', 'Consultation not found');

            expect(mockCacheService.publish).toHaveBeenCalledWith(
                'consultation_job_updates:job-123',
                expect.any(String),
            );
        });

        it('should handle long error messages', async () => {
            const existingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 50,
                createdAt: new Date(),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(existingStatus));

            const longError = 'Error: ' + 'x'.repeat(1000);
            await service.notifyFailed('job-123', longError);

            expect(mockCacheService.setex).toHaveBeenCalled();
        });

        it('should do nothing when job not found', async () => {
            mockCacheService.get.mockResolvedValue(null);

            await service.notifyFailed('non-existent', 'Some error');

            expect(mockCacheService.setex).not.toHaveBeenCalled();
            expect(mockCacheService.publish).not.toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // subscribeToJobUpdates Tests
    // ===========================================================================

    describe('subscribeToJobUpdates', () => {
        it('should emit error and complete when job not found', async () => {
            mockCacheService.get.mockResolvedValue(null);

            const events: MessageEvent[] = [];
            await new Promise<void>((resolve) => {
                service.subscribeToJobUpdates('non-existent-job').subscribe({
                    next: (event) => events.push(event),
                    complete: () => resolve(),
                });
            });

            expect(events).toHaveLength(1);
            const data = JSON.parse(events[0].data as string);
            expect(data.error).toBe('Job not found');
            expect(data.jobId).toBe('non-existent-job');
        });

        it('should emit final status and complete for COMPLETED job', async () => {
            const completedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'COMPLETED',
                progress: 100,
                result: { contextItemId: 'ctx-1', content: 'Summary' },
                createdAt: new Date('2026-02-01T10:00:00Z'),
                completedAt: new Date('2026-02-01T10:05:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(completedStatus));

            const events: MessageEvent[] = [];
            await new Promise<void>((resolve) => {
                service.subscribeToJobUpdates('job-123').subscribe({
                    next: (event) => events.push(event),
                    complete: () => resolve(),
                });
            });

            expect(events).toHaveLength(1);
            const data = JSON.parse(events[0].data as string);
            expect(data.status).toBe('COMPLETED');
            expect(data.progress).toBe(100);
            expect(mockRedisSubscriber.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should emit final status and complete for FAILED job', async () => {
            const failedStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'FAILED',
                progress: 30,
                error: 'Service unavailable',
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(failedStatus));

            const events: MessageEvent[] = [];
            await new Promise<void>((resolve) => {
                service.subscribeToJobUpdates('job-123').subscribe({
                    next: (event) => events.push(event),
                    complete: () => resolve(),
                });
            });

            expect(events).toHaveLength(1);
            const data = JSON.parse(events[0].data as string);
            expect(data.status).toBe('FAILED');
            expect(data.error).toBe('Service unavailable');
            expect(mockRedisSubscriber.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should emit final status and complete for CANCELLED job', async () => {
            const cancelledStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'PRE_SUMMARY',
                status: 'CANCELLED',
                progress: 0,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(cancelledStatus));

            const events: MessageEvent[] = [];
            await new Promise<void>((resolve) => {
                service.subscribeToJobUpdates('job-123').subscribe({
                    next: (event) => events.push(event),
                    complete: () => resolve(),
                });
            });

            expect(events).toHaveLength(1);
            const data = JSON.parse(events[0].data as string);
            expect(data.status).toBe('CANCELLED');
        });

        it('should subscribe to Redis channel for in-progress job and emit current status immediately', async () => {
            const runningStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 50,
                currentStep: 'Generating summary',
                createdAt: new Date('2026-02-01T10:00:00Z'),
                startedAt: new Date('2026-02-01T10:01:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(runningStatus));

            const subject = new Subject<string>();
            mockRedisSubscriber.subscribeToChannel.mockResolvedValue(subject.asObservable());

            const events: MessageEvent[] = [];
            const subscription = service.subscribeToJobUpdates('job-123').subscribe({
                next: (event) => events.push(event),
            });

            // Allow the async setup to complete
            await new Promise((r) => setTimeout(r, 50));

            // First event should be the current status
            expect(events.length).toBeGreaterThanOrEqual(1);
            const firstData = JSON.parse(events[0].data as string);
            expect(firstData.status).toBe('RUNNING');
            expect(firstData.progress).toBe(50);

            expect(mockRedisSubscriber.subscribeToChannel).toHaveBeenCalledWith(
                'consultation_job_updates:job-123',
            );

            subscription.unsubscribe();
        });

        it('should stream Redis pub/sub messages as SSE events', async () => {
            const pendingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(pendingStatus));

            const subject = new Subject<string>();
            mockRedisSubscriber.subscribeToChannel.mockResolvedValue(subject.asObservable());

            const events: MessageEvent[] = [];
            const subscription = service.subscribeToJobUpdates('job-123').subscribe({
                next: (event) => events.push(event),
            });

            await new Promise((r) => setTimeout(r, 50));

            // Simulate progress updates via Redis pub/sub
            subject.next(JSON.stringify({
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 25,
                currentStep: 'Loading content',
            }));

            subject.next(JSON.stringify({
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 75,
                currentStep: 'Generating output',
            }));

            await new Promise((r) => setTimeout(r, 50));

            // events[0] = current status (PENDING), events[1] = progress 25%, events[2] = progress 75%
            expect(events.length).toBe(3);

            const progress1 = JSON.parse(events[1].data as string);
            expect(progress1.progress).toBe(25);

            const progress2 = JSON.parse(events[2].data as string);
            expect(progress2.progress).toBe(75);

            subscription.unsubscribe();
        });

        it('should complete the stream when terminal status received via Redis', async () => {
            const runningStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 80,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(runningStatus));

            const subject = new Subject<string>();
            mockRedisSubscriber.subscribeToChannel.mockResolvedValue(subject.asObservable());

            const events: MessageEvent[] = [];
            let completed = false;
            service.subscribeToJobUpdates('job-123').subscribe({
                next: (event) => events.push(event),
                complete: () => { completed = true; },
            });

            await new Promise((r) => setTimeout(r, 50));

            // Send terminal COMPLETED event
            subject.next(JSON.stringify({
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'COMPLETED',
                progress: 100,
                currentStep: 'Completed',
            }));

            await new Promise((r) => setTimeout(r, 50));

            // Should include the terminal event (takeWhile with inclusive=true)
            const lastEvent = JSON.parse(events[events.length - 1].data as string);
            expect(lastEvent.status).toBe('COMPLETED');
            expect(completed).toBe(true);
        });

        it('should clean up Redis subscription on stream completion', async () => {
            const runningStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'RUNNING',
                progress: 50,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(runningStatus));

            const subject = new Subject<string>();
            mockRedisSubscriber.subscribeToChannel.mockResolvedValue(subject.asObservable());

            const events: MessageEvent[] = [];
            service.subscribeToJobUpdates('job-123').subscribe({
                next: (event) => events.push(event),
            });

            await new Promise((r) => setTimeout(r, 50));

            // Send terminal event to trigger finalize
            subject.next(JSON.stringify({
                jobId: 'job-123',
                type: 'NER',
                status: 'COMPLETED',
                progress: 100,
            }));

            await new Promise((r) => setTimeout(r, 50));

            expect(mockRedisSubscriber.unsubscribeFromChannel).toHaveBeenCalledWith(
                'consultation_job_updates:job-123',
            );
        });

        it('should handle getJobStatus error gracefully', async () => {
            mockCacheService.get.mockRejectedValue(new Error('Redis connection lost'));

            const events: MessageEvent[] = [];
            await new Promise<void>((resolve) => {
                service.subscribeToJobUpdates('job-123').subscribe({
                    next: (event) => events.push(event),
                    complete: () => resolve(),
                });
            });

            expect(events).toHaveLength(1);
            const data = JSON.parse(events[0].data as string);
            expect(data.error).toBe('Failed to subscribe to job updates');
        });

        it('should pass through malformed Redis messages as raw data', async () => {
            const pendingStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'PENDING',
                progress: 0,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(pendingStatus));

            const subject = new Subject<string>();
            mockRedisSubscriber.subscribeToChannel.mockResolvedValue(subject.asObservable());

            const events: MessageEvent[] = [];
            const subscription = service.subscribeToJobUpdates('job-123').subscribe({
                next: (event) => events.push(event),
            });

            await new Promise((r) => setTimeout(r, 50));

            // Send a malformed (non-JSON) message via Redis
            subject.next('this-is-not-json');

            await new Promise((r) => setTimeout(r, 50));

            // events[0] = current status (PENDING), events[1] = raw passthrough
            expect(events.length).toBe(2);
            expect(events[1].data).toBe('this-is-not-json');

            subscription.unsubscribe();
        });

        it('should complete stream when FAILED status received via Redis', async () => {
            const runningStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'NER',
                status: 'RUNNING',
                progress: 40,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(runningStatus));

            const subject = new Subject<string>();
            mockRedisSubscriber.subscribeToChannel.mockResolvedValue(subject.asObservable());

            const events: MessageEvent[] = [];
            let completed = false;
            service.subscribeToJobUpdates('job-123').subscribe({
                next: (event) => events.push(event),
                complete: () => { completed = true; },
            });

            await new Promise((r) => setTimeout(r, 50));

            // Send FAILED terminal event
            subject.next(JSON.stringify({
                jobId: 'job-123',
                type: 'NER',
                status: 'FAILED',
                progress: 40,
                error: 'NLP timeout',
            }));

            await new Promise((r) => setTimeout(r, 50));

            expect(completed).toBe(true);
            const lastEvent = JSON.parse(events[events.length - 1].data as string);
            expect(lastEvent.status).toBe('FAILED');
            expect(lastEvent.error).toBe('NLP timeout');
            expect(mockRedisSubscriber.unsubscribeFromChannel).toHaveBeenCalledWith(
                'consultation_job_updates:job-123',
            );
        });

        it('should handle Redis subscribeToChannel rejection gracefully', async () => {
            const runningStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 50,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(runningStatus));

            mockRedisSubscriber.subscribeToChannel.mockRejectedValue(
                new Error('Redis subscriber not connected'),
            );

            const events: MessageEvent[] = [];
            let completed = false;
            let errored = false;
            await new Promise<void>((resolve) => {
                service.subscribeToJobUpdates('job-123').subscribe({
                    next: (event) => events.push(event),
                    error: () => { errored = true; resolve(); },
                    complete: () => { completed = true; resolve(); },
                });
            });

            // Should have emitted the current status, then caught the error
            // The outer catch block should emit an error event and complete
            const hasErrorEvent = events.some((e) => {
                try {
                    const d = JSON.parse(e.data as string);
                    return d.error !== undefined;
                } catch { return false; }
            });
            expect(hasErrorEvent || errored).toBe(true);
        });

        it('should clean up Redis subscription when client unsubscribes mid-stream', async () => {
            const runningStatus: ConsultationJobStatus = {
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 30,
                createdAt: new Date('2026-02-01T10:00:00Z'),
            };
            mockCacheService.get.mockResolvedValue(JSON.stringify(runningStatus));

            const subject = new Subject<string>();
            mockRedisSubscriber.subscribeToChannel.mockResolvedValue(subject.asObservable());

            const events: MessageEvent[] = [];
            const subscription = service.subscribeToJobUpdates('job-123').subscribe({
                next: (event) => events.push(event),
            });

            await new Promise((r) => setTimeout(r, 50));

            // Send one progress update
            subject.next(JSON.stringify({
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'RUNNING',
                progress: 60,
            }));

            await new Promise((r) => setTimeout(r, 50));
            expect(events.length).toBe(2); // current status + progress

            // Client unsubscribes before job completes
            subscription.unsubscribe();

            await new Promise((r) => setTimeout(r, 50));

            // finalize should have triggered cleanup
            expect(mockRedisSubscriber.unsubscribeFromChannel).toHaveBeenCalledWith(
                'consultation_job_updates:job-123',
            );

            // Further messages should not reach the client
            subject.next(JSON.stringify({
                jobId: 'job-123',
                type: 'SUMMARY',
                status: 'COMPLETED',
                progress: 100,
            }));

            await new Promise((r) => setTimeout(r, 50));
            expect(events.length).toBe(2); // No new events after unsubscribe
        });
    });

    // ===========================================================================
    // Edge Cases and Integration Scenarios
    // ===========================================================================

    describe('Edge Cases', () => {
        it('should handle concurrent job creation requests', async () => {
            // Simulate multiple parallel job creations
            const promises = [
                service.createPreSummaryJob('c1', 't1', 'u1', {}),
                service.createSummaryJob('c2', 't1', 'u1', {}),
                service.createNerJob('ctx1', 'c3', 't1', 'u1'),
            ];

            const results = await Promise.all(promises);

            expect(results).toHaveLength(3);
            expect(mockPreSummaryQueue.add).toHaveBeenCalledTimes(1);
            expect(mockSummaryQueue.add).toHaveBeenCalledTimes(1);
            expect(mockNerQueue.add).toHaveBeenCalledTimes(1);
        });

        it('should handle special characters in consultationId', async () => {
            await service.createPreSummaryJob(
                'consultation-äöü-特殊-123',
                'tenant-1',
                'user-1',
                {},
            );

            expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
                'generate',
                expect.objectContaining({
                    consultationId: 'consultation-äöü-特殊-123',
                }),
                expect.any(Object),
            );
        });

        it('should handle very long request options', async () => {
            const largeOptions: Record<string, unknown> = {};
            for (let i = 0; i < 100; i++) {
                largeOptions[`option_${i}`] = `value_${'x'.repeat(100)}`;
            }

            await service.createSummaryJob(
                'consultation-123',
                'tenant-1',
                'user-1',
                { options: largeOptions },
            );

            expect(mockSummaryQueue.add).toHaveBeenCalled();
        });

        it('should preserve job order in queue', async () => {
            // Create jobs sequentially
            await service.createPreSummaryJob('c1', 't1', 'u1', {});
            await service.createPreSummaryJob('c2', 't1', 'u1', {});
            await service.createPreSummaryJob('c3', 't1', 'u1', {});

            expect(mockPreSummaryQueue.add).toHaveBeenCalledTimes(3);
        });
    });

    // ===========================================================================
    // Idempotency-Key (Redis-backed dedupe)
    // ===========================================================================

    describe('Idempotency-Key dedupe', () => {
        const validParams = {
            consultationId: 'consultation-idem',
            tenantId: 'tenant-1',
            userId: 'user-1',
            request: { caseNoteIds: ['case-1'] } as const,
            idempotencyKey: 'idem-key-uuid-1234',
        };

        it('createPreSummaryJob returns the prior jobId when the Redis key already exists', async () => {
            mockCacheService.get.mockImplementation(async (key: string) => {
                if (key.startsWith('idempotency:')) return 'prior-job-id-xyz';
                return null;
            });

            const result = await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
                undefined,
                validParams.idempotencyKey,
            );

            expect(result.jobId).toBe('prior-job-id-xyz');
            expect(result.status).toBe('PENDING');
            expect(mockPreSummaryQueue.add).not.toHaveBeenCalled();
        });

        it('createPreSummaryJob persists the new jobId under the idempotency key with 24h TTL', async () => {
            mockCacheService.get.mockResolvedValue(null);

            await service.createPreSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                validParams.request,
                undefined,
                validParams.idempotencyKey,
            );

            const idempotencyCall = mockCacheService.setex.mock.calls.find((args) => String(args[0]).startsWith('idempotency:'));
            expect(idempotencyCall).toBeDefined();
            expect(idempotencyCall![0]).toContain('tenant-1');
            expect(idempotencyCall![0]).toContain('user-1');
            expect(idempotencyCall![0]).toContain('idem-key-uuid-1234');
            expect(idempotencyCall![1]).toBe(86400);
            expect(idempotencyCall![2]).toBe('test-job-id-123');
        });

        it('createSummaryJob honors the idempotency key the same way', async () => {
            mockCacheService.get.mockImplementation(async (key: string) =>
                key.startsWith('idempotency:') ? 'prior-summary-job' : null,
            );

            const result = await service.createSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                {},
                undefined,
                'idem-summary',
            );

            expect(result.jobId).toBe('prior-summary-job');
            expect(mockSummaryQueue.add).not.toHaveBeenCalled();
        });

        it('createComprehensiveSummaryJob honors the idempotency key the same way', async () => {
            mockCacheService.get.mockImplementation(async (key: string) =>
                key.startsWith('idempotency:') ? 'prior-comp-job' : null,
            );

            const result = await service.createComprehensiveSummaryJob(
                validParams.consultationId,
                validParams.tenantId,
                validParams.userId,
                {},
                undefined,
                'idem-comp',
            );

            expect(result.jobId).toBe('prior-comp-job');
            expect(mockComprehensiveSummaryQueue.add).not.toHaveBeenCalled();
        });

        it('namespaces the idempotency key by tenant + user so collisions cannot cross-leak', async () => {
            mockCacheService.get.mockResolvedValue(null);

            await service.createPreSummaryJob('c', 'tenant-A', 'user-1', validParams.request, undefined, 'shared-key');
            await service.createPreSummaryJob('c', 'tenant-B', 'user-1', validParams.request, undefined, 'shared-key');

            const idempotencyKeys = mockCacheService.setex.mock.calls
                .filter((args) => String(args[0]).startsWith('idempotency:'))
                .map((args) => String(args[0]));
            expect(idempotencyKeys.length).toBe(2);
            expect(idempotencyKeys[0]).not.toBe(idempotencyKeys[1]);
        });

        it('skips dedupe entirely when no idempotency key is supplied (back-compat)', async () => {
            mockCacheService.get.mockResolvedValue(null);

            await service.createPreSummaryJob('c', 't1', 'u1', validParams.request);

            const idempotencyCalls = mockCacheService.setex.mock.calls.filter((args) =>
                String(args[0]).startsWith('idempotency:'),
            );
            expect(idempotencyCalls.length).toBe(0);
            expect(mockPreSummaryQueue.add).toHaveBeenCalled();
        });
    });

    // ===========================================================================
    // Tenant + user carry-through to ConsultationJobStatus
    // ===========================================================================

    describe('ConsultationJobStatus carries tenantId + userId', () => {
        const stored = (): Record<string, unknown> => {
            const calls = mockCacheService.setex.mock.calls.filter((args) =>
                String(args[0]).startsWith('consultation_job:'),
            );
            expect(calls.length).toBeGreaterThan(0);
            return JSON.parse(String(calls[0][2])) as Record<string, unknown>;
        };

        it('persists tenantId + userId when storing a PRE_SUMMARY job status', async () => {
            await service.createPreSummaryJob('c-1', 'tenant-A', 'user-A', { dnaStyleId: 's' });
            const payload = stored();
            expect(payload.tenantId).toBe('tenant-A');
            expect(payload.userId).toBe('user-A');
        });

        it('persists tenantId + userId when storing a SUMMARY job status', async () => {
            await service.createSummaryJob('c-1', 'tenant-B', 'user-B', { includeNER: false });
            const payload = stored();
            expect(payload.tenantId).toBe('tenant-B');
            expect(payload.userId).toBe('user-B');
        });

        it('persists tenantId + userId when storing a COMPREHENSIVE_SUMMARY job status', async () => {
            await service.createComprehensiveSummaryJob('c-1', 'tenant-C', 'user-C', {});
            const payload = stored();
            expect(payload.tenantId).toBe('tenant-C');
            expect(payload.userId).toBe('user-C');
        });

        it('persists tenantId + userId when storing a NER job status', async () => {
            await service.createNerJob('ctx-1', 'c-1', 'tenant-D', 'user-D');
            const payload = stored();
            expect(payload.tenantId).toBe('tenant-D');
            expect(payload.userId).toBe('user-D');
        });

        it('returns tenantId + userId from getJobStatus so interceptors can ownership-check', async () => {
            mockCacheService.get.mockResolvedValueOnce(
                JSON.stringify({
                    jobId: 'jobX',
                    type: 'SUMMARY',
                    status: 'RUNNING',
                    consultationId: 'c-1',
                    progress: 30,
                    createdAt: new Date().toISOString(),
                    tenantId: 'tenant-A',
                    userId: 'user-A',
                }),
            );
            const status = await service.getJobStatus('jobX');
            expect(status).toMatchObject({ tenantId: 'tenant-A', userId: 'user-A' });
        });
    });
});
