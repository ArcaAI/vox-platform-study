/**
 * HarnessInternalController's STT batch-trigger routes.
 *
 * `POST/GET /internal/harness/stt/batch-jobs` call the EXACT SAME
 * `TranscriptionJobService.createBatchJob` + `TranscriptionRealtimeService.dispatchDramatiqJob`
 * calls `TranscriptionJobController`'s own batch handlers already make — no duplicate
 * job-processing logic.
 *
 * TASK-1006 — the workflow's speech-to-text node names its AGENT (`agentSlug`); the route resolves it
 * through `AsrAgentResolverService` into the `ResolvedAsrSpec` the job is keyed to. `pipelineId` is
 * gone from the request (a 400 under the global pipe) and from the queue message.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, ValidationPipe } from '@nestjs/common';
import { TranscriptionJobStatus, TranscriptionJobType } from '@arcaai/domains';
import { HarnessCreateSttBatchJobRequest, HarnessInternalController } from '../harness-internal.controller';

const SPEC = { runtimeKey: 'agent-v-1', agent: { slug: 'clinic-transcription', versionId: 'agent-v-1' }, models: { asr: { slug: 'whisper' } } };

function makeCls() {
  const store = new Map<string, unknown>();
  return {
    run: async (fn: () => unknown) => fn(),
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
  };
}

describe('HarnessInternalController — STT batch-trigger routes (Task 5)', () => {
  let controller: HarnessInternalController;
  let jobService: { createBatchJob: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn>; getByConsultation: ReturnType<typeof vi.fn> };
  let realtimeService: { dispatchDramatiqJob: ReturnType<typeof vi.fn> };
  let asrResolver: { resolve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    asrResolver = { resolve: vi.fn().mockResolvedValue({ spec: SPEC }) };
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
      undefined as any, // harnessAssuranceService
      undefined as any, // agentTrajectoryService
      undefined as any, // consultationLoopEventService
      undefined as any, // loopConfigService
      undefined as any, // loopContextTextService
      undefined as any, // liveDocumentationService
      undefined as any, // promptManagementService
      undefined as any, // harnessLiveAssistService
      undefined as any, // consultationEndpointService (the endpoint stage)
      jobService as any,
      realtimeService as any,
      undefined as any, // consultationService
      asrResolver as any,
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
      agentSlug: 'clinic-transcription',
      audioUri: 's3://bucket/key.wav',
      consultationId: 'consultation-1',
      language: 'en',
    } as any);

    // The node NAMED its agent — the explicit tier; the cascade is never consulted.
    expect(asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 't-1', agentSlug: 'clinic-transcription', departmentId: null });
    expect(jobService.createBatchJob).toHaveBeenCalledWith({
      agentVersionId: 'agent-v-1',
      resolvedSpec: SPEC,
      mediaId: expect.any(String),
      consultationId: 'consultation-1',
    });
    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      tenantId: 't-1',
      resolvedSpec: SPEC,
      audioUri: 's3://bucket/key.wav',
      consultationId: 'consultation-1',
      mediaId: 'media-1',
      language: 'en',
      // TASK-1004 — the request's `language` is normalized to a mode and sent as the named kwargs.
      languageMode: 'en',
      languageModeSource: 'request',
    });
    expect(result).toEqual({ jobId: 'job-1', status: TranscriptionJobStatus.QUEUED });
  });

  it('POST stt/batch-jobs is idempotent — a retry with the same consultation+agent version reuses the in-flight job, never re-dispatching', async () => {
    jobService.getByConsultation.mockResolvedValue([
      { id: 'job-1', jobType: TranscriptionJobType.BATCH, agentVersionId: 'agent-v-1', status: TranscriptionJobStatus.PROCESSING },
    ]);

    const result = await controller.createSttBatchJob({
      tenantId: 't-1',
      agentSlug: 'clinic-transcription',
      audioUri: 's3://bucket/key.wav',
      consultationId: 'consultation-1',
    } as any);

    expect(jobService.createBatchJob).not.toHaveBeenCalled();
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'job-1', status: TranscriptionJobStatus.PROCESSING });
  });

  it('POST stt/batch-jobs dispatches a NEW job when the existing consultation job is terminal', async () => {
    jobService.getByConsultation.mockResolvedValue([
      { id: 'job-0', jobType: TranscriptionJobType.BATCH, agentVersionId: 'agent-v-1', status: TranscriptionJobStatus.COMPLETED },
    ]);
    jobService.createBatchJob.mockResolvedValue({ id: 'job-1', mediaId: 'media-1', status: TranscriptionJobStatus.QUEUED });

    const result = await controller.createSttBatchJob({
      tenantId: 't-1',
      agentSlug: 'clinic-transcription',
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
      undefined as any, // harnessLiveAssistService
      undefined as any, // consultationEndpointService (the endpoint stage)
      undefined as any, // transcriptionJobService NOT wired
      undefined as any,
    );

    await expect(bareController.createSttBatchJob({ tenantId: 't-1', agentSlug: 'a-1', audioUri: 's3://x' } as any)).rejects.toThrow();
  });

  it('POST stt/batch-jobs 404s for an agent the tenant cannot see, and writes nothing', async () => {
    asrResolver.resolve.mockRejectedValue(new NotFoundException("Agent 'foreign-agent' not found"));

    await expect(controller.createSttBatchJob({ tenantId: 't-1', agentSlug: 'foreign-agent', audioUri: 's3://x' } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(jobService.createBatchJob).not.toHaveBeenCalled();
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('the request DTO names the agent — a `pipelineId` is refused (400) by the global pipe', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    const error = await pipe
      .transform({ tenantId: 't-1', pipelineId: 'pipeline-1', audioUri: 's3://x' }, { type: 'body', metatype: HarnessCreateSttBatchJobRequest })
      .catch((e: { getResponse: () => { message: string[] } }) => e.getResponse().message);
    expect(error).toEqual(expect.arrayContaining(['property pipelineId should not exist', 'agentSlug should not be empty']));
  });
});
