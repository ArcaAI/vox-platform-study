/**
 * TASK-1021 (C-2) — `GET /internal/models/:slug/serving-spec`: `apps/vllm`'s entry into the
 * engine-build contract. `@Public()` behind `InternalServiceTokenGuard` (the sibling internal
 * posture), `X-Tenant-Id` MANDATORY, CLS pinned to the caller's tenant before the service runs,
 * and excluded from the public docs.
 */
import 'reflect-metadata';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { describe, expect, it, vi } from 'vitest';
import { isEndpointApiExcluded } from '../../../openapi/api-exclude-metadata';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';
import { ModelServingInternalController } from '../model-serving-internal.controller';

const TENANT = 'a0000000-0000-0000-0000-00000000000a';
const SLUG = 'arcaai-whisper-large-ml-en-vllm';

function make() {
  const store = new Map<string, unknown>();
  const cls = {
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((key: string, value: unknown) => void store.set(key, value)),
    get: vi.fn((key: string) => store.get(key)),
  };
  const servingSpecs = { resolve: vi.fn(async () => ({ slug: SLUG, tenantIdSeenByService: store.get('tenantId') })) };
  return { controller: new ModelServingInternalController(servingSpecs as never, cls as never), servingSpecs, cls };
}

describe('ModelServingInternalController (TASK-1021 C-2)', () => {
  it('is GET internal/models/:slug/serving-spec', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ModelServingInternalController)).toBe('internal/models');
    expect(Reflect.getMetadata(PATH_METADATA, ModelServingInternalController.prototype.servingSpec)).toBe(':slug/serving-spec');
    expect(Reflect.getMetadata(METHOD_METADATA, ModelServingInternalController.prototype.servingSpec)).toBe(RequestMethod.GET);
  });

  it('is @Public() behind InternalServiceTokenGuard and excluded from the public docs', () => {
    expect(new Reflector().get(SKIP_AUTH_KEY, ModelServingInternalController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, ModelServingInternalController)).toContain(InternalServiceTokenGuard);
    expect(isEndpointApiExcluded(ModelServingInternalController.prototype.servingSpec)).toBe(true);
  });

  it('answers 400 without X-Tenant-Id, before touching the service', async () => {
    const { controller, servingSpecs } = make();
    await expect(controller.servingSpec(SLUG, 'vllm', undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.servingSpec(SLUG, 'vllm', '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(servingSpecs.resolve).not.toHaveBeenCalled();
  });

  it('resolves for the header tenant, with CLS pinned to it', async () => {
    const { controller, servingSpecs } = make();
    const spec = await controller.servingSpec(SLUG, 'vllm', TENANT);
    expect(servingSpecs.resolve).toHaveBeenCalledWith(SLUG, TENANT);
    expect(spec).toMatchObject({ slug: SLUG, tenantIdSeenByService: TENANT });
  });

  it.each([['nlp'], ['stt'], ['text'], [undefined]])(
    'answers 400 when the caller names service=%s — only vllm reads serving specs',
    async (service) => {
      const { controller, servingSpecs } = make();
      await expect(controller.servingSpec(SLUG, service, TENANT)).rejects.toBeInstanceOf(BadRequestException);
      expect(servingSpecs.resolve).not.toHaveBeenCalled();
    },
  );
});
