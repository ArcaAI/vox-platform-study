/**
 * The local-path registration routes: route metadata, the platform-admin class decorators,
 * the documentation surface, and plain delegation to `ModelPathRegistrationService`.
 */
import { describe, expect, it, vi } from 'vitest';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import { LocalModelPreviewQuery, ModelPathRegistrationService, RegisterFromPathRequest, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { AiModelRegistrationController } from '../ai-model-registration.controller';

const DECORATORS = { API_OPERATION: 'swagger/apiOperation', API_RESPONSE: 'swagger/apiResponse' } as const;
const proto = AiModelRegistrationController.prototype as unknown as Record<string, object>;

const ROUTES: Array<{ method: string; verb: RequestMethod; path: string; code: HttpStatus; statuses: string[] }> = [
  { method: 'previewLocal', verb: RequestMethod.GET, path: 'local/preview', code: HttpStatus.OK, statuses: ['400', '403', '404'] },
  {
    method: 'registerFromPath',
    verb: RequestMethod.POST,
    path: 'register-from-path',
    code: HttpStatus.CREATED,
    statuses: ['400', '403', '404', '409'],
  },
];

describe('AiModelRegistrationController — route metadata', () => {
  for (const route of ROUTES) {
    it(`${route.method} is ${RequestMethod[route.verb]} ${route.path} → ${route.code}`, () => {
      expect(Reflect.getMetadata(PATH_METADATA, proto[route.method])).toBe(route.path);
      expect(Reflect.getMetadata(METHOD_METADATA, proto[route.method])).toBe(route.verb);
      const code = Reflect.getMetadata(HTTP_CODE_METADATA, proto[route.method]);
      if (code !== undefined) expect(code).toBe(route.code);
    });

    it(`${route.method} is documented: summary, description, its 4xx responses`, () => {
      const op = Reflect.getMetadata(DECORATORS.API_OPERATION, proto[route.method]) as { summary?: string; description?: string };
      expect(op?.summary).toBeTruthy();
      expect(op?.description).toBeTruthy();
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto[route.method]) as Record<string, unknown>;
      for (const status of route.statuses) expect(Object.keys(responses)).toContain(status);
    });
  }

  it('keeps the class-level platform-admin gate (manage:all) under admin/ai-models', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AiModelRegistrationController)).toEqual([{ action: 'manage', subject: 'all' }]);
    expect(Reflect.getMetadata(PATH_METADATA, AiModelRegistrationController)).toBe('admin/ai-models');
  });

  it('binds the preview query as ONE whole DTO object (so the pipe polices every parameter)', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AiModelRegistrationController, 'previewLocal') as Record<string, { data?: unknown }>;
    expect(Object.keys(args)).toHaveLength(1);
    expect(Object.values(args)[0].data).toBeUndefined();
  });
});

describe('AiModelRegistrationController — delegation', () => {
  it('the service and both request DTOs it binds exist in @arcaai/applications', () => {
    expect(ModelPathRegistrationService).toBeTypeOf('function');
    expect(LocalModelPreviewQuery).toBeTypeOf('function');
    expect(RegisterFromPathRequest).toBeTypeOf('function');
  });

  it('previewLocal → ModelPathRegistrationService.previewLocal(path)', async () => {
    const previewLocal = vi.fn().mockResolvedValue({ bucketPrefix: 'x/' });
    const controller = new AiModelRegistrationController({ previewLocal } as never);
    expect(await controller.previewLocal({ path: '/mnt/models-bucket/x' })).toEqual({ bucketPrefix: 'x/' });
    expect(previewLocal).toHaveBeenCalledWith('/mnt/models-bucket/x');
  });

  it('registerFromPath → registerFromPath, verbatim', async () => {
    const registerFromPath = vi.fn().mockResolvedValue({ id: 'm1' });
    const controller = new AiModelRegistrationController({ registerFromPath } as never);
    expect(await controller.registerFromPath({ path: 'x/', slug: 'x-model' })).toEqual({ id: 'm1' });
    expect(registerFromPath).toHaveBeenCalledWith({ path: 'x/', slug: 'x-model' });
  });
});
