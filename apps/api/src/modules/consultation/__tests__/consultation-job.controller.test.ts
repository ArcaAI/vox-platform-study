/**
 * ConsultationJobController — unit tests (TASK-263 W0-6 / GAP-01)
 *
 * Covers the new HTTP/SSE surface that maps `useConsultationJob` calls in
 * `@arcaai/vox` to the existing `IConsultationJobService` implementation in
 * `@arcaai/applications`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { of } from 'rxjs';
import { ConsultationJobController } from '../consultation-job.controller';
import {
  TENANT_OWNED_RESOURCE_KEY,
  type TenantOwnedResourceOptions,
} from '../../../common/tenant-owned-resource.decorator';

type MockJobService = {
  getJobStatus: ReturnType<typeof vi.fn>;
  cancelJob: ReturnType<typeof vi.fn>;
  subscribeToJobUpdates: ReturnType<typeof vi.fn>;
};

function createMockJobService(): MockJobService {
  return {
    getJobStatus: vi.fn(),
    cancelJob: vi.fn(),
    subscribeToJobUpdates: vi.fn(),
  };
}

describe('ConsultationJobController', () => {
  let controller: ConsultationJobController;
  let jobService: MockJobService;

  beforeEach(() => {
    vi.clearAllMocks();
    jobService = createMockJobService();
    controller = new ConsultationJobController(jobService as unknown as never);
  });

  // ---------------------------------------------------------------------------
  // GET /consultations/jobs/:jobId
  // ---------------------------------------------------------------------------
  describe('getJob', () => {
    it('returns the job status when service finds the job', async () => {
      const job = {
        jobId: 'job-1',
        type: 'SUMMARY',
        status: 'RUNNING',
        consultationId: 'consult-1',
        progress: 42,
        createdAt: new Date('2026-05-23T00:00:00Z'),
      };
      jobService.getJobStatus.mockResolvedValueOnce(job);

      const result = await controller.getJob('job-1');

      expect(jobService.getJobStatus).toHaveBeenCalledWith('job-1');
      expect(result).toBe(job);
    });

    it('throws NotFoundException when service returns null', async () => {
      jobService.getJobStatus.mockResolvedValueOnce(null);

      await expect(controller.getJob('missing-id')).rejects.toThrow(NotFoundException);
      expect(jobService.getJobStatus).toHaveBeenCalledWith('missing-id');
    });

    it('handler is bound to HTTP GET on path ":jobId"', () => {
      const path = Reflect.getMetadata(PATH_METADATA, ConsultationJobController.prototype.getJob);
      const method = Reflect.getMetadata(METHOD_METADATA, ConsultationJobController.prototype.getJob);
      expect(path).toBe(':jobId');
      expect(method).toBe(RequestMethod.GET);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /consultations/jobs/:jobId/cancel
  // ---------------------------------------------------------------------------
  describe('cancelJob', () => {
    it('returns { ok: true } when service cancels the job', async () => {
      jobService.cancelJob.mockResolvedValueOnce(true);

      const result = await controller.cancelJob('job-1');

      expect(jobService.cancelJob).toHaveBeenCalledWith('job-1');
      expect(result).toEqual({ ok: true });
    });

    it('throws NotFoundException when service cannot cancel (missing or terminal)', async () => {
      jobService.cancelJob.mockResolvedValueOnce(false);

      await expect(controller.cancelJob('missing-id')).rejects.toThrow(NotFoundException);
      expect(jobService.cancelJob).toHaveBeenCalledWith('missing-id');
    });

    it('handler is bound to HTTP PATCH on path ":jobId/cancel"', () => {
      const path = Reflect.getMetadata(PATH_METADATA, ConsultationJobController.prototype.cancelJob);
      const method = Reflect.getMetadata(METHOD_METADATA, ConsultationJobController.prototype.cancelJob);
      expect(path).toBe(':jobId/cancel');
      expect(method).toBe(RequestMethod.PATCH);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /consultations/jobs/:jobId/stream (SSE)
  // ---------------------------------------------------------------------------
  describe('streamJob', () => {
    it('returns the observable produced by subscribeToJobUpdates', () => {
      const stream = of({ data: '{"hello":"world"}' });
      jobService.subscribeToJobUpdates.mockReturnValueOnce(stream);

      const result = controller.streamJob('job-1');

      expect(jobService.subscribeToJobUpdates).toHaveBeenCalledWith('job-1');
      expect(result).toBe(stream);
    });

    it('handler is bound to HTTP GET on path ":jobId/stream"', () => {
      const path = Reflect.getMetadata(PATH_METADATA, ConsultationJobController.prototype.streamJob);
      const method = Reflect.getMetadata(METHOD_METADATA, ConsultationJobController.prototype.streamJob);
      expect(path).toBe(':jobId/stream');
      expect(method).toBe(RequestMethod.GET);
    });

    it('handler is decorated with @Sse() (NestJS marks SSE handlers via SSE_METADATA)', () => {
      const isSse = Reflect.getMetadata(SSE_METADATA, ConsultationJobController.prototype.streamJob);
      expect(isSse).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Class-level route metadata
  // ---------------------------------------------------------------------------
  describe('class-level routing', () => {
    it('@Controller is mounted at "consultations/jobs"', () => {
      const path = Reflect.getMetadata(PATH_METADATA, ConsultationJobController);
      expect(path).toBe('consultations/jobs');
    });
  });

  // ---------------------------------------------------------------------------
  // TASK-307 W3.4 — every per-job handler must carry @TenantOwnedResource so the
  // global TenantOwnedResourceInterceptor can 404 cross-tenant probes (AC-10).
  // ---------------------------------------------------------------------------
  describe('TASK-307 W3.4 — @TenantOwnedResource metadata', () => {
    const meta = (m: keyof ConsultationJobController): TenantOwnedResourceOptions | undefined =>
      Reflect.getMetadata(
        TENANT_OWNED_RESOURCE_KEY,
        ConsultationJobController.prototype[m] as object,
      ) as TenantOwnedResourceOptions | undefined;

    it('getJob is annotated with modelName ConsultationJob + paramName jobId', () => {
      expect(meta('getJob')).toEqual({ modelName: 'ConsultationJob', paramName: 'jobId' });
    });

    it('cancelJob is annotated with modelName ConsultationJob + paramName jobId', () => {
      expect(meta('cancelJob')).toEqual({ modelName: 'ConsultationJob', paramName: 'jobId' });
    });

    it('streamJob is annotated with modelName ConsultationJob + paramName jobId', () => {
      expect(meta('streamJob')).toEqual({ modelName: 'ConsultationJob', paramName: 'jobId' });
    });
  });
});
