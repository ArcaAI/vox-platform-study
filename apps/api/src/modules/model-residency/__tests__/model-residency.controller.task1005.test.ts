import 'reflect-metadata';
import { BadRequestException, HttpStatus, RequestMethod, SetMetadata, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_FORBIDDEN,
  LoadModelResidencyRequest,
  PinModelResidencyRequest,
  REQUIRED_PERMISSIONS_KEY,
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  UnloadModelResidencyRequest,
} from '@arcaai/applications';
import { API_TAGS } from '../../../openapi/tags';
import { ModelResidencyController } from '../model-residency.controller';

/**
 * `@RequiredSvcScopes()` refuses, AT DECORATION TIME, any scope missing from
 * `SERVICE_ACCOUNT_SCOPE_REGISTRY`. The two residency scopes are added to that
 * registry by a sibling lane (TASK-1005 scope-registry change); until it merges,
 * an UNREGISTERED scope is recorded as plain metadata here so this file can
 * import the controller. A registered scope always goes through the real
 * decorator, so once the registry lands this shim does nothing.
 */
vi.mock('@arcaai/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/applications')>();
  return {
    ...actual,
    RequiredSvcScopes: (...scopes: string[]) =>
      scopes.every((scope) => actual.isValidServiceAccountScope(scope))
        ? actual.RequiredSvcScopes(...scopes)
        : SetMetadata(actual.SERVICE_ACCOUNT_REQUIRED_SCOPES, scopes),
  };
});

/**
 * TASK-1005 — `/api/v1/admin/model-residency/*`, exactly the routes of
 * `tests/contracts/model-residency-admin.fixture.json`.
 *
 * The REAL gate (SUPER_ADMIN in a tenant-less context) is imperative in
 * `ModelResidencyService.assertPlatformAdmin` and is tested there; this file
 * pins the declarative layer the boot audits and the route manifest read.
 */

const API_RESPONSE_METADATA = 'swagger/apiResponse';
const API_OPERATION_METADATA = 'swagger/apiOperation';
const API_TAGS_METADATA = 'swagger/apiUseTags';
const REQUIRES_IF_MATCH = 'requiresIfMatch';

const GLOBAL_PIPE = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
const proto = ModelResidencyController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

const ROUTES: Array<[string, RequestMethod, string, 'read' | 'manage']> = [
  ['view', RequestMethod.GET, '/', 'read'],
  ['catalogue', RequestMethod.GET, 'catalogue', 'read'],
  ['load', RequestMethod.POST, 'load', 'manage'],
  ['unload', RequestMethod.POST, 'unload', 'manage'],
  ['pin', RequestMethod.PUT, 'pins', 'manage'],
  ['operation', RequestMethod.GET, 'operations/:operationId', 'read'],
  ['listPolicies', RequestMethod.GET, 'policies', 'read'],
  ['createPolicy', RequestMethod.POST, 'policies', 'manage'],
  ['updatePolicy', RequestMethod.PATCH, 'policies/:id', 'manage'],
  ['deletePolicy', RequestMethod.DELETE, 'policies/:id', 'manage'],
];

describe('ModelResidencyController (TASK-1005)', () => {
  it('mounts under admin/model-residency with exactly the fixture routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ModelResidencyController)).toBe('admin/model-residency');
    for (const [handler, method, path] of ROUTES) {
      expect(Reflect.getMetadata(METHOD_METADATA, proto[handler]), handler).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, proto[handler]), handler).toBe(path);
    }
  });

  it('is admin-plane only: @ForbidApiKey, a class-level CASL permission, and one manage svc scope on every route', () => {
    const reflector = new Reflector();
    expect(reflector.getAllAndOverride(API_KEY_FORBIDDEN, [proto.view, ModelResidencyController])).toBe(true);
    for (const [handler] of ROUTES) {
      const permissions = reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [proto[handler], ModelResidencyController]);
      expect(permissions, handler).toEqual([{ action: 'manage', subject: 'ModelResidencyPolicy' }]);
      const scopes = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [proto[handler], ModelResidencyController]);
      expect(scopes, handler).toEqual(['svc:admin:model-residency:manage']);
    }
  });

  it('documents every route: a declared tag, an operation summary, and at least one 4xx', () => {
    const tags = Reflect.getMetadata(API_TAGS_METADATA, ModelResidencyController) as string[];
    expect(tags).toEqual(['admin-model-residency']);
    expect(API_TAGS.map((t) => t.name)).toContain('admin-model-residency');
    for (const [handler] of ROUTES) {
      expect((Reflect.getMetadata(API_OPERATION_METADATA, proto[handler]) as { summary?: string })?.summary, handler).toBeTruthy();
      const statuses = Object.keys(Reflect.getMetadata(API_RESPONSE_METADATA, proto[handler]) ?? {});
      expect(
        statuses.some((s) => s.startsWith('4')),
        handler,
      ).toBe(true);
      expect(statuses, handler).toContain('403');
    }
  });

  it('the policy PATCH is OCC: @RequiresIfMatch, and the If-Match version wins over the body', async () => {
    expect(Reflect.getMetadata(REQUIRES_IF_MATCH, proto.updatePolicy)).toBe(true);
    const service = { updatePolicy: vi.fn().mockResolvedValue({ id: 'p1' }) };
    const controller = new ModelResidencyController(service as never);
    await controller.updatePolicy('p1', { priority: 5, expectedVersion: 3 }, 7);
    expect(service.updatePolicy).toHaveBeenCalledWith('p1', { priority: 5, expectedVersion: 7 });
  });

  it('load answers 202 when admitted and 200 when already loaded', async () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.load)).toBe(HttpStatus.ACCEPTED);
    const service = {
      load: vi
        .fn()
        .mockResolvedValueOnce({ status: 202, body: { outcome: 'accepted', operationId: 'op-1', model: {} } })
        .mockResolvedValueOnce({ status: 200, body: { outcome: 'already_loaded', model: {} } }),
    };
    const controller = new ModelResidencyController(service as never);
    const res = { status: vi.fn() };

    await expect(controller.load({ service: 'stt', modelRef: 'x' }, res as never)).resolves.toMatchObject({ outcome: 'accepted' });
    expect(res.status).not.toHaveBeenCalled();
    await expect(controller.load({ service: 'stt', modelRef: 'x' }, res as never)).resolves.toMatchObject({ outcome: 'already_loaded' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('GET catalogue (§13) delegates to the service`s catalogue-first view and documents it', async () => {
    const view = { mode: 'shadow', services: [] };
    const service = { getCatalogue: vi.fn().mockResolvedValue(view) };
    const controller = new ModelResidencyController(service as never);
    await expect(controller.catalogue()).resolves.toBe(view);
    expect(service.getCatalogue).toHaveBeenCalledTimes(1);

    const operation = Reflect.getMetadata(API_OPERATION_METADATA, proto.catalogue) as { summary?: string; description?: string };
    expect(operation.description).toMatch(/SELF_HOSTED/);
    const responses = Reflect.getMetadata(API_RESPONSE_METADATA, proto.catalogue) as Record<string, unknown>;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '403']));
  });

  it('unload and pin answer 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.unload)).toBe(HttpStatus.OK);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.pin)).toBe(HttpStatus.OK);
  });

  describe('request bodies — the global pipe', () => {
    const validate = (metatype: unknown, body: unknown) => GLOBAL_PIPE.transform(body, { type: 'body', metatype: metatype as never });

    it('accepts the fixture load body verbatim (nullable options, null reason)', async () => {
      const fixtureLoad = {
        service: 'lm-studio',
        modelRef: 'gemma-4-e4b-it-qat@q4_0',
        pin: false,
        force: false,
        reason: null,
        replace: false,
        options: { contextLength: 8192, evalBatchSize: null, flashAttention: true, numExperts: null, offloadKvCacheToGpu: null },
      };
      await expect(validate(LoadModelResidencyRequest, fixtureLoad)).resolves.toBeInstanceOf(LoadModelResidencyRequest);
    });

    for (const [what, body] of [
      ['an undeclared LM Studio key (ttl)', { service: 'lm-studio', modelRef: 'x', options: { ttl: 120 } }],
      ['the read-only stt-worker', { service: 'stt-worker', modelRef: 'x' }],
      ['an unknown service', { service: 'text', modelRef: 'x' }],
      ['an empty modelRef', { service: 'stt', modelRef: '' }],
    ] as const) {
      it(`refuses ${what}`, async () => {
        await expect(validate(LoadModelResidencyRequest, body)).rejects.toBeInstanceOf(BadRequestException);
      });
    }

    it('accepts the fixture unload and pin bodies', async () => {
      await expect(
        validate(UnloadModelResidencyRequest, { service: 'nlp', modelRef: 'gliner-medical-large', force: false, reason: null }),
      ).resolves.toBeDefined();
      await expect(
        validate(PinModelResidencyRequest, { service: 'stt', modelRef: 'arcaai-whisper-ml-en-ggml', pinned: true, ttlSeconds: null }),
      ).resolves.toBeDefined();
    });
  });
});
