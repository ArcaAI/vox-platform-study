/**
 * Consultation Job Queue Integration Tests
 *
 * These tests verify the integration between:
 * - ConsultationJobService (job creation and status management)
 * - Job Processors (pre-summary, comprehensive-summary)
 * - Redis/BullMQ (queue operations)
 *
 * NOTE: These are "integration" tests but run with mocked external dependencies
 * (Redis, HTTP services). True E2E tests would require running infrastructure.
 *
 * `createSummaryJob`/`createNerJob` (the legacy `SUMMARY_REGENERATE`
 * async generator and its NER companion) were deleted along with
 * `summary.processor.ts`/`ner.processor.ts`. The generic job-lifecycle
 * scenarios below (which never cared WHICH job type they exercised) now use
 * `createPreSummaryJob`/`createComprehensiveSummaryJob` — the two surviving
 * job types — as their vehicle; the "Queue Integration" describe block
 * (which specifically asserted per-type queue routing) drops its SUMMARY/NER
 * cases since those queues no longer exist.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Queue } from 'bullmq';
import { ConsultationJobService } from '../../consultation-job.service';

// Mock Redis service
const createMockRedisService = () => {
  const storage = new Map<string, string>();

  return {
    get: vi.fn(async (key: string) => storage.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      storage.set(key, value);
    }),
    del: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    _storage: storage,
    _clear: () => storage.clear(),
  };
};

// Mock Redis subscriber service
const createMockRedisSubscriber = () => ({
  subscribeToChannel: vi.fn(),
  unsubscribeFromChannel: vi.fn(),
});

// Mock BullMQ Queue
const createMockQueue = () => {
  const jobs = new Map<string, { data: any; opts: any }>();

  return {
    add: vi.fn(async (name: string, data: any, opts: any) => {
      jobs.set(opts.jobId, { data, opts });
      return { id: opts.jobId, data };
    }),
    getJob: vi.fn(async (jobId: string) => {
      const job = jobs.get(jobId);
      if (!job) return null;
      return {
        id: jobId,
        data: job.data,
        getState: vi.fn().mockResolvedValue('waiting'),
        remove: vi.fn().mockResolvedValue(undefined),
      };
    }),
    _jobs: jobs,
    _clear: () => jobs.clear(),
  };
};

describe('Consultation Job Queue Integration Tests', () => {
  let jobService: ConsultationJobService;
  let mockRedisService: ReturnType<typeof createMockRedisService>;
  let mockRedisSubscriber: ReturnType<typeof createMockRedisSubscriber>;
  let mockPreSummaryQueue: ReturnType<typeof createMockQueue>;
  let mockComprehensiveSummaryQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRedisService = createMockRedisService();
    mockRedisSubscriber = createMockRedisSubscriber();
    mockPreSummaryQueue = createMockQueue();
    mockComprehensiveSummaryQueue = createMockQueue();

    jobService = new ConsultationJobService(
      mockPreSummaryQueue as unknown as Queue,
      mockComprehensiveSummaryQueue as unknown as Queue,
      mockRedisService as any,
      mockRedisSubscriber as any,
    );
  });

  afterEach(() => {
    mockRedisService._clear();
    mockPreSummaryQueue._clear();
    mockComprehensiveSummaryQueue._clear();
  });

  // ===========================================================================
  // Job Creation and Status Flow Tests
  // ===========================================================================

  describe('Job Creation and Status Flow', () => {
    it('should create job and track status through PENDING -> RUNNING -> COMPLETED', async () => {
      // Step 1: Create job
      const jobResponse = await jobService.createPreSummaryJob('consultation-123', 'tenant-1', 'user-1', { dnaStyleId: 'style-1' });

      expect(jobResponse.status).toBe('PENDING');
      const jobId = jobResponse.jobId;

      // Verify initial status in Redis
      let status = await jobService.getJobStatus(jobId);
      expect(status).not.toBeNull();
      expect(status?.status).toBe('PENDING');
      expect(status?.progress).toBe(0);

      // Step 2: Simulate processor starting (notifyProgress)
      await jobService.notifyProgress(jobId, 10, 'Gathering case notes');

      status = await jobService.getJobStatus(jobId);
      expect(status?.status).toBe('RUNNING');
      expect(status?.progress).toBe(10);
      expect(status?.currentStep).toBe('Gathering case notes');
      expect(status?.startedAt).toBeDefined();

      // Step 3: Simulate progress updates
      await jobService.notifyProgress(jobId, 30, 'Generating pre-summary with AI');
      status = await jobService.getJobStatus(jobId);
      expect(status?.progress).toBe(30);

      await jobService.notifyProgress(jobId, 70, 'Saving results');
      status = await jobService.getJobStatus(jobId);
      expect(status?.progress).toBe(70);

      // Step 4: Simulate completion
      const result = { contextItemId: 'ctx-new', content: 'Pre-summary text' };
      await jobService.notifyComplete(jobId, result);

      status = await jobService.getJobStatus(jobId);
      expect(status?.status).toBe('COMPLETED');
      expect(status?.progress).toBe(100);
      expect(status?.result).toEqual(result);
      expect(status?.completedAt).toBeDefined();
    });

    it('should handle job failure correctly', async () => {
      // Create job
      const jobResponse = await jobService.createComprehensiveSummaryJob('consultation-456', 'tenant-1', 'user-1', { template: 'soap-note' });
      const jobId = jobResponse.jobId;

      // Simulate processing starts
      await jobService.notifyProgress(jobId, 10, 'Gathering context');
      await jobService.notifyProgress(jobId, 30, 'Generating summary with AI');

      // Simulate failure
      await jobService.notifyFailed(jobId, 'TEXT service timeout after 120 seconds');

      const status = await jobService.getJobStatus(jobId);
      expect(status?.status).toBe('FAILED');
      expect(status?.error).toBe('TEXT service timeout after 120 seconds');
      expect(status?.completedAt).toBeDefined();
      expect(status?.progress).toBe(30); // Progress stays where it was
    });

    it('should handle job cancellation correctly', async () => {
      // Create job
      const jobResponse = await jobService.createPreSummaryJob('consultation-789', 'tenant-1', 'user-1', {});
      const jobId = jobResponse.jobId;

      // Cancel while PENDING
      const cancelled = await jobService.cancelJob(jobId);
      expect(cancelled).toBe(true);

      const status = await jobService.getJobStatus(jobId);
      expect(status?.status).toBe('CANCELLED');
      expect(status?.completedAt).toBeDefined();
    });

    it('should not allow cancellation of completed job', async () => {
      // Create and complete job
      const jobResponse = await jobService.createPreSummaryJob('consultation-complete', 'tenant-1', 'user-1', {});
      const jobId = jobResponse.jobId;

      await jobService.notifyComplete(jobId, { content: 'Done' });

      // Try to cancel
      const cancelled = await jobService.cancelJob(jobId);
      expect(cancelled).toBe(false);

      // Status should still be COMPLETED
      const status = await jobService.getJobStatus(jobId);
      expect(status?.status).toBe('COMPLETED');
    });

    it('should not allow cancellation of failed job', async () => {
      const jobResponse = await jobService.createComprehensiveSummaryJob('consultation-failed', 'tenant-1', 'user-1', {});
      const jobId = jobResponse.jobId;

      await jobService.notifyFailed(jobId, 'Some error');

      const cancelled = await jobService.cancelJob(jobId);
      expect(cancelled).toBe(false);
    });
  });

  // ===========================================================================
  // Queue Integration Tests
  // ===========================================================================

  describe('Queue Integration', () => {
    it('should add job to correct queue for PRE_SUMMARY', async () => {
      await jobService.createPreSummaryJob('consultation-pre', 'tenant-1', 'user-1', { dnaStyleId: 'style-1', caseNoteIds: ['case-1'] });

      expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
        'generate',
        expect.objectContaining({
          consultationId: 'consultation-pre',
          tenantId: 'tenant-1',
          userId: 'user-1',
          request: { dnaStyleId: 'style-1', caseNoteIds: ['case-1'] },
        }),
        expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        }),
      );
      expect(mockComprehensiveSummaryQueue.add).not.toHaveBeenCalled();
    });

    it('should add job to correct queue for COMPREHENSIVE_SUMMARY (not the pre-summary queue)', async () => {
      await jobService.createComprehensiveSummaryJob('consultation-sum', 'tenant-1', 'user-1', { template: 'discharge', includeLabResults: true });

      expect(mockComprehensiveSummaryQueue.add).toHaveBeenCalledWith(
        'generate',
        expect.objectContaining({
          consultationId: 'consultation-sum',
          request: { template: 'discharge', includeLabResults: true },
        }),
        expect.any(Object),
      );
      expect(mockPreSummaryQueue.add).not.toHaveBeenCalled();
    });

    it('should include callback URL in job payload when provided', async () => {
      await jobService.createPreSummaryJob('consultation-callback', 'tenant-1', 'user-1', {}, 'https://example.com/callback');

      expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
        'generate',
        expect.objectContaining({
          callbackUrl: 'https://example.com/callback',
        }),
        expect.any(Object),
      );
    });
  });

  // ===========================================================================
  // Redis Pub/Sub Integration Tests
  // ===========================================================================

  describe('Redis Pub/Sub Integration', () => {
    it('should publish status updates to Redis channel', async () => {
      const jobResponse = await jobService.createPreSummaryJob('consultation-pub', 'tenant-1', 'user-1', {});
      const jobId = jobResponse.jobId;

      // Progress update should publish
      await jobService.notifyProgress(jobId, 50, 'Processing');
      expect(mockRedisService.publish).toHaveBeenCalledWith(`consultation_job_updates:${jobId}`, expect.any(String));

      // Verify published data
      const publishCall = mockRedisService.publish.mock.calls[0];
      const publishedData = JSON.parse(publishCall[1]);
      expect(publishedData.progress).toBe(50);
      expect(publishedData.status).toBe('RUNNING');
    });

    it('should publish completion event to Redis channel', async () => {
      const jobResponse = await jobService.createComprehensiveSummaryJob('consultation-complete-pub', 'tenant-1', 'user-1', {});
      const jobId = jobResponse.jobId;

      const result = { contextItemId: 'ctx-1', content: 'Summary' };
      await jobService.notifyComplete(jobId, result);

      expect(mockRedisService.publish).toHaveBeenCalled();
      const lastPublishCall = mockRedisService.publish.mock.calls.slice(-1)[0];
      const publishedData = JSON.parse(lastPublishCall[1]);
      expect(publishedData.status).toBe('COMPLETED');
      expect(publishedData.result).toEqual(result);
    });

    it('should publish failure event to Redis channel', async () => {
      const jobResponse = await jobService.createPreSummaryJob('consultation-fail-pub', 'tenant-1', 'user-1', {});
      const jobId = jobResponse.jobId;

      await jobService.notifyFailed(jobId, 'NLP service unavailable');

      expect(mockRedisService.publish).toHaveBeenCalled();
      const lastPublishCall = mockRedisService.publish.mock.calls.slice(-1)[0];
      const publishedData = JSON.parse(lastPublishCall[1]);
      expect(publishedData.status).toBe('FAILED');
      expect(publishedData.error).toBe('NLP service unavailable');
    });
  });

  // ===========================================================================
  // Multiple Jobs Integration Tests
  // ===========================================================================

  describe('Multiple Jobs Integration', () => {
    it('should handle multiple concurrent jobs independently', async () => {
      // Create two different job types
      const [preSummaryJob, comprehensiveJob] = await Promise.all([
        jobService.createPreSummaryJob('c1', 't1', 'u1', {}),
        jobService.createComprehensiveSummaryJob('c2', 't1', 'u1', {}),
      ]);

      // Verify all jobs are created with PENDING status
      const statuses = await Promise.all([jobService.getJobStatus(preSummaryJob.jobId), jobService.getJobStatus(comprehensiveJob.jobId)]);

      expect(statuses[0]?.type).toBe('PRE_SUMMARY');
      expect(statuses[1]?.type).toBe('COMPREHENSIVE_SUMMARY');
      expect(statuses.every((s) => s?.status === 'PENDING')).toBe(true);
    });

    it('should update jobs independently', async () => {
      const job1 = await jobService.createPreSummaryJob('c1', 't1', 'u1', {});
      const job2 = await jobService.createComprehensiveSummaryJob('c2', 't1', 'u1', {});

      // Progress job1 to RUNNING
      await jobService.notifyProgress(job1.jobId, 50, 'Step 1');

      // Complete job2
      await jobService.notifyComplete(job2.jobId, { content: 'Done' });

      // Verify independence
      const status1 = await jobService.getJobStatus(job1.jobId);
      const status2 = await jobService.getJobStatus(job2.jobId);

      expect(status1?.status).toBe('RUNNING');
      expect(status1?.progress).toBe(50);

      expect(status2?.status).toBe('COMPLETED');
      expect(status2?.progress).toBe(100);
    });

    it('should handle sequential jobs for same consultation', async () => {
      const consultationId = 'consultation-sequential';

      // Create pre-summary job
      const preSummaryJob = await jobService.createPreSummaryJob(consultationId, 'tenant-1', 'user-1', {});

      // Complete pre-summary
      await jobService.notifyComplete(preSummaryJob.jobId, { contextItemId: 'pre-ctx' });

      // Create comprehensive summary job (using pre-summary result)
      const comprehensiveJob = await jobService.createComprehensiveSummaryJob(consultationId, 'tenant-1', 'user-1', { contextItemIds: ['pre-ctx'] });

      // Complete comprehensive summary
      await jobService.notifyComplete(comprehensiveJob.jobId, { contextItemId: 'sum-ctx' });

      // Verify both completed
      const preSummaryStatus = await jobService.getJobStatus(preSummaryJob.jobId);
      const comprehensiveStatus = await jobService.getJobStatus(comprehensiveJob.jobId);

      expect(preSummaryStatus?.status).toBe('COMPLETED');
      expect(comprehensiveStatus?.status).toBe('COMPLETED');
    });
  });

  // ===========================================================================
  // Job Persistence Tests
  // ===========================================================================

  describe('Job Persistence', () => {
    it('should persist job status with 24-hour TTL', async () => {
      await jobService.createPreSummaryJob('c1', 't1', 'u1', {});

      expect(mockRedisService.setex).toHaveBeenCalledWith(
        expect.stringContaining('consultation_job:'),
        86400, // 24 hours
        expect.any(String),
      );
    });

    it('should maintain job status across multiple reads', async () => {
      const job = await jobService.createPreSummaryJob('c1', 't1', 'u1', {});

      // Multiple reads should return consistent data
      const status1 = await jobService.getJobStatus(job.jobId);
      const status2 = await jobService.getJobStatus(job.jobId);
      const status3 = await jobService.getJobStatus(job.jobId);

      expect(status1).toEqual(status2);
      expect(status2).toEqual(status3);
    });

    it('should return null for non-existent job', async () => {
      const status = await jobService.getJobStatus('non-existent-job-id');
      expect(status).toBeNull();
    });
  });

  // ===========================================================================
  // Error Recovery Tests
  // ===========================================================================

  describe('Error Recovery', () => {
    it('should preserve job state if progress update fails', async () => {
      const job = await jobService.createPreSummaryJob('c1', 't1', 'u1', {});

      // Simulate Redis failure for one update
      mockRedisService.setex.mockRejectedValueOnce(new Error('Redis unavailable'));

      // This should throw but not corrupt state
      try {
        await jobService.notifyProgress(job.jobId, 50, 'Step');
      } catch {
        // Expected to fail
      }

      // Status should still be PENDING (from initial create)
      const status = await jobService.getJobStatus(job.jobId);
      expect(status?.status).toBe('PENDING');
    });

    it('should handle job that exists in queue but not in Redis', async () => {
      // This simulates a race condition where job was added to queue
      // but Redis write failed

      // Cancel should return false for unknown job
      const result = await jobService.cancelJob('ghost-job');
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // Data Integrity Tests
  // ===========================================================================

  describe('Data Integrity', () => {
    it('should preserve all job data through lifecycle', async () => {
      const request = {
        dnaStyleId: 'style-special',
        caseNoteIds: ['case-1', 'case-2', 'case-3'],
        options: { temperature: 0.7, maxTokens: 2000 },
      };
      const callbackUrl = 'https://webhook.example.com/callback';

      const job = await jobService.createPreSummaryJob('consultation-integrity', 'tenant-integrity', 'user-integrity', request, callbackUrl);

      // Verify job was added with all data
      expect(mockPreSummaryQueue.add).toHaveBeenCalledWith(
        'generate',
        expect.objectContaining({
          jobId: job.jobId,
          consultationId: 'consultation-integrity',
          tenantId: 'tenant-integrity',
          userId: 'user-integrity',
          request,
          callbackUrl,
        }),
        expect.any(Object),
      );

      // Verify status includes correct type and consultation
      const status = await jobService.getJobStatus(job.jobId);
      expect(status?.type).toBe('PRE_SUMMARY');
      expect(status?.consultationId).toBe('consultation-integrity');
    });

    it('should preserve timestamps through updates', async () => {
      const job = await jobService.createPreSummaryJob('c1', 't1', 'u1', {});

      const initialStatus = await jobService.getJobStatus(job.jobId);
      const createdAt = initialStatus?.createdAt;

      // Wait a tiny bit to ensure timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update progress
      await jobService.notifyProgress(job.jobId, 50, 'Step');
      const runningStatus = await jobService.getJobStatus(job.jobId);

      // createdAt should be preserved
      expect(runningStatus?.createdAt?.getTime()).toBe(createdAt?.getTime());
      // startedAt should now be set
      expect(runningStatus?.startedAt).toBeDefined();
    });

    it('should serialize and deserialize dates correctly', async () => {
      const job = await jobService.createPreSummaryJob('c1', 't1', 'u1', {});
      await jobService.notifyComplete(job.jobId, { content: 'Done' });

      const status = await jobService.getJobStatus(job.jobId);

      // All date fields should be Date objects, not strings
      expect(status?.createdAt).toBeInstanceOf(Date);
      expect(status?.completedAt).toBeInstanceOf(Date);
    });
  });

  // ===========================================================================
  // Realistic Workflow Tests (Anti-Pattern #1 Prevention)
  // These tests simulate real-world consultation processing workflows
  // ===========================================================================

  describe('Realistic Workflow Scenarios', () => {
    it('should complete a realistic consultation summary workflow', async () => {
      // Simulate: User starts a consultation, records speech, gets transcription,
      // then requests a pre-summary

      const consultationId = 'consultation-workflow-1';
      const tenantId = 'hospital-tenant';
      const userId = 'dr-smith';

      // Step 1: Create pre-summary job
      const preSummaryJob = await jobService.createPreSummaryJob(consultationId, tenantId, userId, {
        dnaStyleId: 'clinical-soap',
        caseNoteIds: ['case-subjective', 'case-objective'],
      });

      expect(preSummaryJob.status).toBe('PENDING');
      expect(preSummaryJob.estimatedSeconds).toBe(30);

      // Step 2: Simulate processing steps
      await jobService.notifyProgress(preSummaryJob.jobId, 10, 'Gathering case notes');
      let status = await jobService.getJobStatus(preSummaryJob.jobId);
      expect(status?.status).toBe('RUNNING');
      expect(status?.currentStep).toBe('Gathering case notes');

      await jobService.notifyProgress(preSummaryJob.jobId, 30, 'Generating pre-summary with AI');
      await jobService.notifyProgress(preSummaryJob.jobId, 70, 'Saving results');

      // Step 3: Complete with realistic result
      const preSummaryResult = {
        contextItemId: 'ctx-pre-summary-001',
        content: 'Patient presents with 3-week history of frontal headaches, 6/10 severity. No red flags identified.',
        summaryMeta: {
          aiModelId: 'gpt-4-turbo',
          processingTimeMs: 2847,
          inputTokens: 234,
          outputTokens: 89,
        },
      };
      await jobService.notifyComplete(preSummaryJob.jobId, preSummaryResult);

      // Verify final state
      const finalStatus = await jobService.getJobStatus(preSummaryJob.jobId);
      expect(finalStatus?.status).toBe('COMPLETED');
      expect(finalStatus?.progress).toBe(100);
      expect(finalStatus?.result).toEqual(preSummaryResult);
      expect(finalStatus?.completedAt).toBeDefined();
    });

    it('should handle parallel comprehensive-summary jobs for multiple consultations', async () => {
      // Simulate: Multiple cross-chain comprehensive summaries requested simultaneously

      const consultationIds = ['consultation-parallel-1', 'consultation-parallel-2', 'consultation-parallel-3'];

      // Create jobs in parallel
      const jobs = await Promise.all(consultationIds.map((id) => jobService.createComprehensiveSummaryJob(id, 'tenant-1', 'user-1', {})));

      // Verify all jobs were created with correct associations
      expect(jobs).toHaveLength(3);
      for (let i = 0; i < jobs.length; i++) {
        const status = await jobService.getJobStatus(jobs[i].jobId);
        expect(status?.type).toBe('COMPREHENSIVE_SUMMARY');
        expect(status?.consultationId).toBe(consultationIds[i]);
      }

      // Simulate parallel completion with different results
      const results = [
        { contextItemId: 'ctx-1', namedEntities: [{ id: 'e1', entityType: 'PERSON', value: 'John' }] },
        { contextItemId: 'ctx-2', namedEntities: [{ id: 'e2', entityType: 'MEDICATION', value: 'Aspirin' }] },
        { contextItemId: 'ctx-3', namedEntities: [{ id: 'e3', entityType: 'CONDITION', value: 'Hypertension' }] },
      ];

      await Promise.all(jobs.map((job, i) => jobService.notifyComplete(job.jobId, results[i])));

      // Verify all completed with correct results
      for (let i = 0; i < jobs.length; i++) {
        const status = await jobService.getJobStatus(jobs[i].jobId);
        expect(status?.status).toBe('COMPLETED');
        expect((status?.result as any)?.namedEntities).toHaveLength(1);
      }
    });

    it('should handle job failure recovery scenario', async () => {
      // Simulate: Job starts, fails due to service unavailability, should be trackable

      const job = await jobService.createComprehensiveSummaryJob('consultation-failure', 'tenant-1', 'user-1', { template: 'discharge-summary' });

      // Start processing
      await jobService.notifyProgress(job.jobId, 10, 'Gathering context');
      await jobService.notifyProgress(job.jobId, 30, 'Calling AI service');

      // Simulate failure
      const errorMessage = 'TEXT service returned 503: Service temporarily unavailable. Retry after 30 seconds.';
      await jobService.notifyFailed(job.jobId, errorMessage);

      // Verify failure state is properly captured
      const status = await jobService.getJobStatus(job.jobId);
      expect(status?.status).toBe('FAILED');
      expect(status?.error).toBe(errorMessage);
      expect(status?.progress).toBe(30); // Stopped at last progress
      expect(status?.completedAt).toBeDefined();

      // Verify the job data is still accessible for retry analysis
      expect(status?.consultationId).toBe('consultation-failure');
      expect(status?.type).toBe('COMPREHENSIVE_SUMMARY');
    });

    it('should handle long-running job with multiple progress updates', async () => {
      const job = await jobService.createComprehensiveSummaryJob('consultation-long', 'tenant-1', 'user-1', {
        includeLabResults: true,
        contextItemIds: Array(10).fill('ctx-id'),
      });

      // Simulate realistic progress for processing 10 context items
      const progressSteps = [
        { progress: 5, step: 'Initializing' },
        { progress: 10, step: 'Loading context item 1/10' },
        { progress: 20, step: 'Loading context item 3/10' },
        { progress: 30, step: 'Loading context item 5/10' },
        { progress: 40, step: 'Loading context item 8/10' },
        { progress: 50, step: 'All context items loaded' },
        { progress: 60, step: 'Sending to AI service' },
        { progress: 70, step: 'Processing AI response' },
        { progress: 80, step: 'Extracting named entities' },
        { progress: 90, step: 'Saving results' },
      ];

      for (const { progress, step } of progressSteps) {
        await jobService.notifyProgress(job.jobId, progress, step);

        const status = await jobService.getJobStatus(job.jobId);
        expect(status?.progress).toBe(progress);
        expect(status?.currentStep).toBe(step);
        expect(status?.status).toBe('RUNNING');
      }

      // Complete
      await jobService.notifyComplete(job.jobId, {
        contextItemId: 'summary-final',
        content: 'Comprehensive summary...',
        namedEntities: Array(25).fill({ id: 'e', entityType: 'ENTITY', value: 'value' }),
      });

      const finalStatus = await jobService.getJobStatus(job.jobId);
      expect(finalStatus?.status).toBe('COMPLETED');
      expect(finalStatus?.progress).toBe(100);
    });

    it('should track job duration correctly', async () => {
      const job = await jobService.createPreSummaryJob('c1', 't1', 'u1', {});

      const initialStatus = await jobService.getJobStatus(job.jobId);
      const createdAt = initialStatus?.createdAt!;

      // Wait and then start processing
      await new Promise((resolve) => setTimeout(resolve, 50));
      await jobService.notifyProgress(job.jobId, 10, 'Starting');

      const runningStatus = await jobService.getJobStatus(job.jobId);
      const startedAt = runningStatus?.startedAt!;

      // startedAt should be after createdAt
      expect(startedAt.getTime()).toBeGreaterThan(createdAt.getTime());

      // Wait and complete
      await new Promise((resolve) => setTimeout(resolve, 50));
      await jobService.notifyComplete(job.jobId, { content: 'Done' });

      const completedStatus = await jobService.getJobStatus(job.jobId);
      const completedAt = completedStatus?.completedAt!;

      // completedAt should be after startedAt
      expect(completedAt.getTime()).toBeGreaterThan(startedAt.getTime());

      // Verify all timestamps are preserved
      expect(completedStatus?.createdAt?.getTime()).toBe(createdAt.getTime());
      expect(completedStatus?.startedAt?.getTime()).toBe(startedAt.getTime());
    });
  });
});
