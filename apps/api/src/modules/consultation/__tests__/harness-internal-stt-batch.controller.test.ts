/**
 * TASK-724 Task 5 — HarnessInternalController's STT batch-trigger routes.
 *
 * `POST/GET /internal/harness/stt/batch-jobs` are the ONLY new surface Task 5 adds:
 * they call the EXACT SAME `TranscriptionJobService.createBatchJob` +
 * `TranscriptionRealtimeService.dispatchDramatiqJob` calls
 * `TranscriptionJobController`'s own batch handlers already make — no duplicate
 * job-processing logic. This route lives under `apps/api/src/modules/consultation/**`,
 * never `apps/api/src/modules/streaming/**`, so the realtime-hot-path grep-gate stays
 * green (see `task-724-stt-realtime-untouched.grep-gate.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranscriptionJobStatus, TranscriptionJobType } from '@arcaai/domains';
import { HarnessInternalController } from '../harness-internal.controller';

function makeCls() {
  const store = new Map<string, unknown>();
  return {
    run: async (fn: () => unknown) => fn(),
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
  };
}

describe('HarnessInternalController — STT batch-trigger routes (TASK-724 Task 5)', () => {
  let controller: HarnessInternalController;
  let jobService: { createBatchJob: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn>; getByConsultation: ReturnType<typeof vi.fn> };
  let realtimeService: { dispatchDramatiqJob: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    jobService = {
      createBatchJob: vi.fn(),
      getById: vi.fn(),
      getByConsultation: vi.fn().mockResolvedValue([]),
    };
    realtimeService = { dispatchDramatiqJob: vi.fn().mockResolvedValue(undefined) };

    controller = new HarnessInternalController(
      undefined as any, // harnessInternalService (unused by these routes)
      undefined as any, // harnessPolicyService
      makeCls() as any, // cls
      undefined as any, // harnessProgressService
      undefined as any, // harnessAssuranceService
      undefined as any, // agentTrajectoryService
      undefined as any, // consultationLoopEventService
      undefined as any, // loopConfigService
      undefined as any, // loopContextTextService
      undefined as any, // liveDocumentationService
      undefined as any, // promptManagementService
      undefined as any, // harnessLiveAssistService (TASK-795 RC-2)
      jobService as any,
      realtimeService as any,
    );
  });

  it('POST stt/batch-jobs creates a job and dispatches it via the EXISTING write path', async () => {
    jobService.createBatchJob.mockResolvedValue({
      id: 'job-1',
      mediaId: 'media-1',
      status: TranscriptionJobStatus.QUEUED,
    });

    const result = await controller.createSttBatchJob({
      tenantId: 't-1',
      pipelineId: 'pipeline-1',
      audioUri: 's3://bucket/key.wav',
      consultationId: 'consultation-1',
      language: 'en',
    } as any);

    expect(jobService.createBatchJob).toHaveBeenCalledWith({
      pipelineId: 'pipeline-1',
      mediaId: expect.any(String),
      consultationId: 'consultation-1',
    });
    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      tenantId: 't-1',
      pipelineId: 'pipeline-1',
      audioUri: 's3://bucket/key.wav',
      consultationId: 'consultation-1',
      mediaId: 'media-1',
      language: 'en',
    });
    expect(result).toEqual({ jobId: 'job-1', status: TranscriptionJobStatus.QUEUED });
  });

  it('POST stt/batch-jobs is idempotent — a retry with the same consultation+pipeline reuses the in-flight job, never re-dispatching', async () => {
    jobService.getByConsultation.mockResolvedValue([
      { id: 'job-1', jobType: TranscriptionJobType.BATCH, pipelineId: 'pipeline-1', status: TranscriptionJobStatus.PROCESSING },
    ]);

    const result = await controller.createSttBatchJob({
      tenantId: 't-1',
      pipelineId: 'pipeline-1',
      audioUri: 's3://bucket/key.wav',
      consultationId: 'consultation-1',
    } as any);

    expect(jobService.createBatchJob).not.toHaveBeenCalled();
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'job-1', status: TranscriptionJobStatus.PROCESSING });
  });

  it('POST stt/batch-jobs dispatches a NEW job when the existing consultation job is terminal', async () => {
    jobService.getByConsultation.mockResolvedValue([
      { id: 'job-0', jobType: TranscriptionJobType.BATCH, pipelineId: 'pipeline-1', status: TranscriptionJobStatus.COMPLETED },
    ]);
    jobService.createBatchJob.mockResolvedValue({ id: 'job-1', mediaId: 'media-1', status: TranscriptionJobStatus.QUEUED });

    const result = await controller.createSttBatchJob({
      tenantId: 't-1',
      pipelineId: 'pipeline-1',
      audioUri: 's3://bucket/key.wav',
      consultationId: 'consultation-1',
    } as any);

    expect(jobService.createBatchJob).toHaveBeenCalled();
    expect(result.jobId).toBe('job-1');
  });

  it('GET stt/batch-jobs/:id returns the job status, progress and error fields', async () => {
    jobService.getById.mockResolvedValue({
      id: 'job-1',
      status: TranscriptionJobStatus.FAILED,
      progress: 40,
      errorMessage: 'boom',
      errorCode: 'ASR_TIMEOUT',
    });

    const result = await controller.getSttBatchJobStatus('job-1', 't-1');

    expect(jobService.getById).toHaveBeenCalledWith('job-1');
    expect(result).toEqual({
      jobId: 'job-1',
      status: TranscriptionJobStatus.FAILED,
      progress: 40,
      errorMessage: 'boom',
      errorCode: 'ASR_TIMEOUT',
    });
  });

  it('GET stt/batch-jobs/:id without tenantId throws and never touches the service', async () => {
    await expect(controller.getSttBatchJobStatus('job-1', undefined)).rejects.toThrow();
    expect(jobService.getById).not.toHaveBeenCalled();
  });

  it('GET stt/batch-jobs/:id 404s for an unknown job', async () => {
    jobService.getById.mockResolvedValue(null);
    await expect(controller.getSttBatchJobStatus('missing', 't-1')).rejects.toThrow();
  });

  it('POST stt/batch-jobs throws when the STT batch services are not wired', async () => {
    const bareController = new HarnessInternalController(
      undefined as any,
      undefined as any,
      makeCls() as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any, // harnessLiveAssistService (TASK-795 RC-2)
      undefined as any, // transcriptionJobService NOT wired
      undefined as any,
    );

    await expect(bareController.createSttBatchJob({ tenantId: 't-1', pipelineId: 'p-1', audioUri: 's3://x' } as any)).rejects.toThrow();
  });
});
