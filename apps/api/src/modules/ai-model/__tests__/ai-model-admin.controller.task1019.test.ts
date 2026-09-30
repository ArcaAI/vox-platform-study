/**
 * TASK-1019 — the registry operation routes on `AiModelAdminController`:
 * route metadata, the platform-admin class decorators they inherit, the
 * documentation surface, and plain delegation to `ModelRegistryOperationsService`.
 */
import { describe, expect, it, vi } from 'vitest';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { HttpStatus, RequestMethod } from '@nestjs/common';
// `DECORATORS.API_OPERATION` / `API_RESPONSE` — the swagger constants subpath is not exported.
const DECORATORS = { API_OPERATION: 'swagger/apiOperation', API_RESPONSE: 'swagger/apiResponse' } as const;
import { AiModelAdminController } from '../ai-model-admin.controller';

const proto = AiModelAdminController.prototype as unknown as Record<string, object>;

const ROUTES: Array<{ method: string; verb: RequestMethod; path: string; code?: HttpStatus }> = [
  { method: 'previewHub', verb: RequestMethod.GET, path: 'hub/preview' },
  { method: 'registerFromHub', verb: RequestMethod.POST, path: 'register-from-hub', code: HttpStatus.ACCEPTED },
  { method: 'downloadMissing', verb: RequestMethod.POST, path: 'download-missing', code: HttpStatus.ACCEPTED },
  { method: 'getUsage', verb: RequestMethod.GET, path: ':id/usage' },
  { method: 'unregister', verb: RequestMethod.POST, path: ':id/unregister', code: HttpStatus.ACCEPTED },
];

function controllerWith(ops: Record<string, unknown>) {
  return new AiModelAdminController({} as never, {} as never, {} as never, ops as never);
}

describe('AiModelAdminController — TASK-1019 route metadata', () => {
  for (const route of ROUTES) {
    it(`${route.method} is ${RequestMethod[route.verb]} ${route.path}${route.code ? ` → ${route.code}` : ''}`, () => {
      expect(Reflect.getMetadata(PATH_METADATA, proto[route.method])).toBe(route.path);
      expect(Reflect.getMetadata(METHOD_METADATA, proto[route.method])).toBe(route.verb);
      if (route.code) expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto[route.method])).toBe(route.code);
    });

    it(`${route.method} is documented: summary, description, a 4xx response`, () => {
      const op = Reflect.getMetadata(DECORATORS.API_OPERATION, proto[route.method]) as { summary?: string; description?: string };
      expect(op?.summary).toBeTruthy();
      expect(op?.description).toBeTruthy();
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, proto[route.method]) as Record<string, unknown>;
      expect(Object.keys(responses).some((status) => status.startsWith('4'))).toBe(true);
      expect(Object.keys(responses)).toContain('403');
    });
  }

  it('the static routes register BEFORE the `:id` family (a static path must never be captured as an id)', () => {
    const order = Object.getOwnPropertyNames(AiModelAdminController.prototype);
    for (const staticRoute of ['previewHub', 'registerFromHub', 'downloadMissing']) {
      expect(order.indexOf(staticRoute)).toBeLessThan(order.indexOf('fetchById'));
    }
  });

  it('binds the preview query as ONE whole DTO object (so the pipe polices every parameter)', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AiModelAdminController, 'previewHub') as Record<string, { data?: unknown }>;
    expect(Object.keys(args)).toHaveLength(1);
    expect(Object.values(args)[0].data).toBeUndefined();
  });
});

describe('AiModelAdminController — TASK-1019 delegation', () => {
  it('previewHub → ModelRegistryOperationsService.previewHub', async () => {
    const previewHub = vi.fn().mockResolvedValue({ repoId: 'o/n' });
    expect(await controllerWith({ previewHub }).previewHub({ repoId: 'o/n' })).toEqual({ repoId: 'o/n' });
    expect(previewHub).toHaveBeenCalledWith({ repoId: 'o/n' });
  });

  it('registerFromHub → registerFromHub, verbatim', async () => {
    const registerFromHub = vi.fn().mockResolvedValue({ model: { id: 'm1' }, jobId: 'j1' });
    expect(await controllerWith({ registerFromHub }).registerFromHub({ repoId: 'o/n' })).toEqual({ model: { id: 'm1' }, jobId: 'j1' });
    expect(registerFromHub).toHaveBeenCalledWith({ repoId: 'o/n' });
  });

  it('downloadMissing → downloadMissing', async () => {
    const downloadMissing = vi.fn().mockResolvedValue({ enqueued: [], skipped: [] });
    expect(await controllerWith({ downloadMissing }).downloadMissing()).toEqual({ enqueued: [], skipped: [] });
  });

  it('getUsage → getUsage(id)', async () => {
    const getUsage = vi.fn().mockResolvedValue({ modelId: 'm1', slug: 's', inUse: false, referrers: [] });
    await controllerWith({ getUsage }).getUsage('m1');
    expect(getUsage).toHaveBeenCalledWith('m1');
  });

  it('unregister → unregister(id, body); an absent body is the defaults', async () => {
    const unregister = vi.fn().mockResolvedValue({ jobId: 'j', weights: 'deleting' });
    const controller = controllerWith({ unregister });
    await controller.unregister('m1', { purge: true });
    await controller.unregister('m2', undefined as never);
    expect(unregister).toHaveBeenNthCalledWith(1, 'm1', { purge: true });
    expect(unregister).toHaveBeenNthCalledWith(2, 'm2', {});
  });
});
