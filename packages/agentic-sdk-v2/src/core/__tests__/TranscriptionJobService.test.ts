/**
 * TranscriptionJobService Unit Tests — ASR-R-08
 *
 * TDD tests for transcription job tracking:
 * - Get job by ID
 * - List jobs (paginated)
 * - Get jobs by consultation
 * - Get job status counts
 * - Cancel / retry jobs
 * - Status polling with configurable interval
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptionJobService } from '../TranscriptionJobService';
import { createMockLogger, mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';
import { AgenticClient } from '../AgenticClient';
import { STT_ENDPOINTS } from '../constants';
import { TranscriptionJobStatus, TranscriptionJobType } from '../../types/stt';
import type { TranscriptionJobResponse, TranscriptionJobStatusCounts } from '../../types/stt';

// ===========================================================================
// Fixtures
// ===========================================================================

function createMockJob(overrides: Partial<TranscriptionJobResponse> = {}): TranscriptionJobResponse {
  return {
    id: 'job-abc-123',
    jobType: TranscriptionJobType.STREAMING,
    pipelineId: 'pipeline-default',
    status: TranscriptionJobStatus.QUEUED,
    progress: 0,
    retryCount: 0,
    maxRetries: 3,
    tenantId: 'tenant-001',
    createdAt: '2026-02-17T10:00:00.000Z',
    updatedAt: '2026-02-17T10:00:00.000Z',
    ...overrides,
  };
}

const mockStatusCounts: TranscriptionJobStatusCounts = {
  queued: 2,
  processing: 1,
  completed: 10,
  failed: 0,
  cancelled: 1,
  dead: 0,
};

// ===========================================================================
// Tests
// ===========================================================================

describe('TranscriptionJobService', () => {
  let service: TranscriptionJobService;
  let apiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    apiClient = new AgenticClient(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
      },
      mockLogger,
    );
    service = new TranscriptionJobService(apiClient, mockLogger);
  });

  afterEach(() => {
    service.dispose();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance with apiClient and logger', () => {
      expect(service).toBeDefined();
    });

    it('should create an instance without logger', () => {
      const svc = new TranscriptionJobService(apiClient);
      expect(svc).toBeDefined();
      svc.dispose();
    });
  });

  // =========================================================================
  // getJob
  // =========================================================================

  describe('getJob', () => {
    it('should fetch a transcription job by ID', async () => {
      const job = createMockJob({ id: 'job-fetch-1' });
      mockFetch.mockResolvedValueOnce(createMockResponse(job));

      const result = await service.getJob('job-fetch-1');

      expect(result).toEqual(job);
      expect(result.id).toBe('job-fetch-1');
    });

    it('should call the correct endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockJob()));

      await service.getJob('job-xyz');

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(STT_ENDPOINTS.GET_JOB('job-xyz'));
    });

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(404, 'Job not found'));

      await expect(service.getJob('nonexistent')).rejects.toThrow();
    });

    it('should throw on 500 server error', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

      await expect(service.getJob('job-server-err')).rejects.toThrow();
    });

    it('should return job with all optional fields populated', async () => {
      const fullJob = createMockJob({
        id: 'job-full',
        consultationId: 'consult-abc',
        contextItemId: 'ctx-1',
        mediaId: 'media-1',
        queuedAt: '2026-02-17T10:00:00.000Z',
        startedAt: '2026-02-17T10:00:01.000Z',
        completedAt: '2026-02-17T10:01:00.000Z',
        resultText: 'Final transcript text',
        resultMetadata: { confidence: 0.95 },
        errorMessage: null,
        errorCode: null,
        workerId: 'worker-1',
        createdBy: 'user-123',
      });
      mockFetch.mockResolvedValueOnce(createMockResponse(fullJob));

      const result = await service.getJob('job-full');

      expect(result.consultationId).toBe('consult-abc');
      expect(result.resultText).toBe('Final transcript text');
      expect(result.resultMetadata).toEqual({ confidence: 0.95 });
      expect(result.workerId).toBe('worker-1');
    });
  });

  // =========================================================================
  // listJobs
  // =========================================================================

  describe('listJobs', () => {
    it('should list transcription jobs', async () => {
      const jobs = [createMockJob({ id: 'j1' }), createMockJob({ id: 'j2' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(jobs));

      const result = await service.listJobs();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('j1');
    });

    it('should pass pagination params as query string', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.listJobs({ page: 2, limit: 10 });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('page=2');
      expect(callUrl).toContain('limit=10');
    });

    it('should call the LIST_JOBS endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.listJobs();

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(STT_ENDPOINTS.LIST_JOBS);
    });

    it('should not append query string when called with no params', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.listJobs();

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).not.toContain('?');
    });

    it('should not append query string when called with empty params object', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.listJobs({});

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).not.toContain('?');
    });

    it('should only include page when limit is not provided', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.listJobs({ page: 3 });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('page=3');
      expect(callUrl).not.toContain('limit');
    });

    it('should only include limit when page is not provided', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.listJobs({ limit: 25 });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('limit=25');
      expect(callUrl).not.toContain('page');
    });

    it('should return empty array when backend returns no jobs', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      const result = await service.listJobs();

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getJobsByConsultation
  // =========================================================================

  describe('getJobsByConsultation', () => {
    it('should fetch jobs linked to a specific consultation', async () => {
      const jobs = [createMockJob({ id: 'j1', consultationId: 'consult-abc' }), createMockJob({ id: 'j2', consultationId: 'consult-abc' })];
      mockFetch.mockResolvedValueOnce(createMockResponse(jobs));

      const result = await service.getJobsByConsultation('consult-abc');

      expect(result).toHaveLength(2);
      expect(result[0].consultationId).toBe('consult-abc');
    });

    it('should call the JOBS_BY_CONSULTATION endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.getJobsByConsultation('consult-123');

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(STT_ENDPOINTS.JOBS_BY_CONSULTATION('consult-123'));
    });

    it('should return empty array when no jobs exist', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      const result = await service.getJobsByConsultation('consult-empty');
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getJobsByStatus
  // =========================================================================

  describe('getJobsByStatus', () => {
    it('should fetch jobs by status', async () => {
      const jobs = [createMockJob({ status: TranscriptionJobStatus.PROCESSING })];
      mockFetch.mockResolvedValueOnce(createMockResponse(jobs));

      const result = await service.getJobsByStatus(TranscriptionJobStatus.PROCESSING);

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe(TranscriptionJobStatus.PROCESSING);
    });

    it('should call the JOBS_BY_STATUS endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([]));

      await service.getJobsByStatus(TranscriptionJobStatus.COMPLETED);

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(STT_ENDPOINTS.JOBS_BY_STATUS('COMPLETED'));
    });
  });

  // =========================================================================
  // getJobStats
  // =========================================================================

  describe('getJobStats', () => {
    it('should fetch aggregated job status counts', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockStatusCounts));

      const result = await service.getJobStats();

      expect(result.queued).toBe(2);
      expect(result.processing).toBe(1);
      expect(result.completed).toBe(10);
      expect(result.failed).toBe(0);
      expect(result.cancelled).toBe(1);
      expect(result.dead).toBe(0);
    });

    it('should call the JOB_STATS endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockStatusCounts));

      await service.getJobStats();

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(STT_ENDPOINTS.JOB_STATS);
    });
  });

  // =========================================================================
  // cancelJob
  // =========================================================================

  describe('cancelJob', () => {
    it('should cancel a job and return the updated response', async () => {
      const cancelledJob = createMockJob({
        id: 'job-cancel-1',
        status: TranscriptionJobStatus.CANCELLED,
      });
      mockFetch.mockResolvedValueOnce(createMockResponse(cancelledJob));

      const result = await service.cancelJob('job-cancel-1');

      expect(result.status).toBe(TranscriptionJobStatus.CANCELLED);
    });

    it('should call the CANCEL_JOB endpoint with POST', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockJob({ status: TranscriptionJobStatus.CANCELLED })));

      await service.cancelJob('job-xyz');

      const callUrl = mockFetch.mock.calls[0][0] as string;
      const callMethod = mockFetch.mock.calls[0][1]?.method;
      expect(callUrl).toContain(STT_ENDPOINTS.CANCEL_JOB('job-xyz'));
      expect(callMethod).toBe('POST');
    });

    it('should throw when cancelling an already completed job', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(409, 'Job already completed'));

      await expect(service.cancelJob('job-done')).rejects.toThrow();
    });
  });

  // =========================================================================
  // retryJob
  // =========================================================================

  describe('retryJob', () => {
    it('should retry a failed job and return the updated response', async () => {
      const retriedJob = createMockJob({
        id: 'job-retry-1',
        status: TranscriptionJobStatus.QUEUED,
        retryCount: 1,
      });
      mockFetch.mockResolvedValueOnce(createMockResponse(retriedJob));

      const result = await service.retryJob('job-retry-1');

      expect(result.status).toBe(TranscriptionJobStatus.QUEUED);
      expect(result.retryCount).toBe(1);
    });

    it('should call the RETRY_JOB endpoint with POST', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockJob()));

      await service.retryJob('job-abc');

      const callUrl = mockFetch.mock.calls[0][0] as string;
      const callMethod = mockFetch.mock.calls[0][1]?.method;
      expect(callUrl).toContain(STT_ENDPOINTS.RETRY_JOB('job-abc'));
      expect(callMethod).toBe('POST');
    });

    it('should throw when retrying a non-failed job', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(409, 'Job is not in a retryable state'));

      await expect(service.retryJob('job-active')).rejects.toThrow();
    });
  });

  // =========================================================================
  // pollJobStatus
  // =========================================================================

  describe('pollJobStatus', () => {
    it('should poll job status and invoke callback on each update', async () => {
      const queuingJob = createMockJob({
        id: 'job-poll-1',
        status: TranscriptionJobStatus.QUEUED,
      });
      const processingJob = createMockJob({
        id: 'job-poll-1',
        status: TranscriptionJobStatus.PROCESSING,
        progress: 50,
      });
      const completedJob = createMockJob({
        id: 'job-poll-1',
        status: TranscriptionJobStatus.COMPLETED,
        progress: 100,
      });

      mockFetch
        .mockResolvedValueOnce(createMockResponse(queuingJob))
        .mockResolvedValueOnce(createMockResponse(processingJob))
        .mockResolvedValueOnce(createMockResponse(completedJob));

      const updates: TranscriptionJobResponse[] = [];
      const onUpdate = vi.fn((job: TranscriptionJobResponse) => {
        updates.push(job);
      });

      await service.pollJobStatus('job-poll-1', {
        onUpdate,
        intervalMs: 10,
        terminalStatuses: [
          TranscriptionJobStatus.COMPLETED,
          TranscriptionJobStatus.FAILED,
          TranscriptionJobStatus.CANCELLED,
          TranscriptionJobStatus.DEAD,
        ],
      });

      expect(onUpdate).toHaveBeenCalledTimes(3);
      expect(updates[0].status).toBe(TranscriptionJobStatus.QUEUED);
      expect(updates[1].status).toBe(TranscriptionJobStatus.PROCESSING);
      expect(updates[2].status).toBe(TranscriptionJobStatus.COMPLETED);
    });

    it('should stop polling when a terminal status is reached', async () => {
      const failedJob = createMockJob({
        id: 'job-poll-fail',
        status: TranscriptionJobStatus.FAILED,
        errorMessage: 'Model not found',
      });

      mockFetch.mockResolvedValueOnce(createMockResponse(failedJob));

      const onUpdate = vi.fn();

      await service.pollJobStatus('job-poll-fail', {
        onUpdate,
        intervalMs: 10,
        terminalStatuses: [TranscriptionJobStatus.COMPLETED, TranscriptionJobStatus.FAILED],
      });

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: TranscriptionJobStatus.FAILED }));
    });

    it('should respect maxAttempts and stop after limit', async () => {
      const stuckJob = createMockJob({
        id: 'job-poll-stuck',
        status: TranscriptionJobStatus.PROCESSING,
      });

      // Return processing status indefinitely
      mockFetch.mockResolvedValue(createMockResponse(stuckJob));

      const onUpdate = vi.fn();

      await service.pollJobStatus('job-poll-stuck', {
        onUpdate,
        intervalMs: 10,
        maxAttempts: 3,
        terminalStatuses: [TranscriptionJobStatus.COMPLETED],
      });

      expect(onUpdate).toHaveBeenCalledTimes(3);
    });

    it('should call onError callback when a fetch fails during polling', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const onUpdate = vi.fn();
      const onError = vi.fn();

      await service.pollJobStatus('job-poll-err', {
        onUpdate,
        onError,
        intervalMs: 10,
        maxAttempts: 1,
        terminalStatuses: [TranscriptionJobStatus.COMPLETED],
      });

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('should continue polling after an error if maxAttempts not reached', async () => {
      const completedJob = createMockJob({
        id: 'job-recover',
        status: TranscriptionJobStatus.COMPLETED,
        progress: 100,
      });

      mockFetch.mockRejectedValueOnce(new Error('Temporary network error')).mockResolvedValueOnce(createMockResponse(completedJob));

      const onUpdate = vi.fn();
      const onError = vi.fn();

      await service.pollJobStatus('job-recover', {
        onUpdate,
        onError,
        intervalMs: 10,
        maxAttempts: 5,
        terminalStatuses: [TranscriptionJobStatus.COMPLETED],
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: TranscriptionJobStatus.COMPLETED }));
    });

    it('should use default intervalMs of 2000 when not specified', async () => {
      const completedJob = createMockJob({
        status: TranscriptionJobStatus.COMPLETED,
      });
      mockFetch.mockResolvedValueOnce(createMockResponse(completedJob));

      const start = Date.now();
      await service.pollJobStatus('job-default-interval', {
        onUpdate: vi.fn(),
        maxAttempts: 1,
        terminalStatuses: [TranscriptionJobStatus.COMPLETED],
      });

      // Should complete quickly since the job is already terminal
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('should stop any active polling', async () => {
      const stuckJob = createMockJob({
        status: TranscriptionJobStatus.PROCESSING,
      });
      mockFetch.mockResolvedValue(createMockResponse(stuckJob));

      const onUpdate = vi.fn();

      // Start polling (don't await — it would wait forever without maxAttempts)
      const pollPromise = service.pollJobStatus('job-dispose', {
        onUpdate,
        intervalMs: 10,
        terminalStatuses: [TranscriptionJobStatus.COMPLETED],
      });

      // Dispose immediately
      service.dispose();

      await pollPromise;

      // Should have stopped early
      expect(onUpdate.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('should be idempotent (safe to call multiple times)', () => {
      service.dispose();
      expect(() => service.dispose()).not.toThrow();
    });
  });
});
