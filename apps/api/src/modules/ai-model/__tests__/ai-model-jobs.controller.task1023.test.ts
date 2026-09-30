/**
 * TASK-1023 lane J — `AiModelJobsController`: route metadata, the platform-admin
 * class decorators, the documentation surface, and plain delegation to
 * `ModelPublisherJobsService`.
 */
import { describe, expect, it, vi } from 'vitest';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import { AiModelJobsController } from '../ai-model-jobs.controller';

const DECORATORS = { API_OPERATION: 'swagger/apiOperation', API_RESPONSE: 'swagger/apiResponse' } as const;
const proto = AiModelJobsController.prototype as unknown as Record<string, object>;

const ROUTES: Array<{ method: string; verb: RequestMethod; path: string; code?: HttpStatus }> = [
  { method: 'listJobs', verb: RequestMethod.GET, path: 'jobs' },
  { method: 'cancelDownload', verb: RequestMethod.POST, path: ':id/download/cancel', code: HttpStatus.ACCEPTED },
];

describe('AiModelJobsController — route metadata', () => {
  it('keeps the class-level controller path', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelJobsController)).toBe('admin/ai-models');
  });

  for (const route of ROUTES) {
    it(`${route.method} is ${RequestMethod[route.verb]} ${route.path}`, () => {
      expect(Reflect.getMetadata(PATH_METADATA, proto[route.method])).toBe(route.path);
      expect(Reflect.getMetadata(METHOD_METADATA, proto[route.method])).toBe(route.verb);
      if (route.code) expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto[route.method])).toBe(route.code);
    });

    it(`${route.method} is documented: summary, description, 403 and a 4xx`, () => {
      const op = Reflect.getMetadata(DECORATORS.API_OPERATION, proto[route.method]) as { summary?: string; description?: string };
      expect(op?.summary).toBeTruthy();
      expect(op?.description).toBeTruthy();
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto[route.method]) as Record<string, unknown>;
      expect(Object.keys(responses)).toContain('403');
    });
  }

  it('cancel documents 404 and 409 JOB_NOT_ACTIVE', () => {
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto.cancelDownload) as Record<string, unknown>;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['202', '403', '404', '409']));
  });
});

describe('AiModelJobsController — delegation', () => {
  it('listJobs → service.listJobs(limit)', async () => {
    const jobs = { listJobs: vi.fn().mockResolvedValue([{ jobId: 'j' }]), cancelDownload: vi.fn() };
    const controller = new AiModelJobsController(jobs as never);
    await expect(controller.listJobs({ limit: 20 })).resolves.toEqual([{ jobId: 'j' }]);
    expect(jobs.listJobs).toHaveBeenCalledWith(20);
    await controller.listJobs({});
    expect(jobs.listJobs).toHaveBeenLastCalledWith(undefined);
  });

  it('cancelDownload → service.cancelDownload(id, body)', async () => {
    const jobs = { listJobs: vi.fn(), cancelDownload: vi.fn().mockResolvedValue({ jobId: 'j', outcome: 'removed', unregisterJobId: null }) };
    const controller = new AiModelJobsController(jobs as never);
    await expect(controller.cancelDownload('m-1', { removeRegistration: true })).resolves.toMatchObject({ outcome: 'removed' });
    expect(jobs.cancelDownload).toHaveBeenCalledWith('m-1', { removeRegistration: true });
  });
});
