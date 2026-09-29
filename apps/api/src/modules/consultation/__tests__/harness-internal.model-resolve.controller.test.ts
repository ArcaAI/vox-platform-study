/**
 * F11 — `GET /api/v1/internal/harness/models/resolve`.
 *
 * The route the durable `core.classify` node has called since TASK-864 and
 * which did not exist: `apps/api/route-manifest.json` carried
 * `/internal/agents/resolve` and `/internal/harness/prompt-templates/:id/
 * resolved`, and nothing that resolves a registry model by slug — so every
 * classify node degraded on a 404 at model resolution.
 *
 * Thin controller, like every other route on this class: validate the two
 * REQUIRED query parameters and delegate. The cascade, the 404-over-403 posture
 * and the fail-closed selection all live in `HarnessInternalService`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { HarnessInternalController } from '../harness-internal.controller';

const mockService = { resolveRegistryModel: vi.fn(), resolveTaskModel: vi.fn() };

function build() {
  return new HarnessInternalController(
    mockService as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );
}

describe('HarnessInternalController — models/resolve', () => {
  let controller: HarnessInternalController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = build();
  });

  it('delegates (slug, tenantId, taskType) to the service', async () => {
    mockService.resolveRegistryModel.mockResolvedValue({ slug: 'medical-ner', taskType: 'TOKEN_CLASSIFICATION' });

    const result = await controller.resolveRegistryModel('medical-ner', 't-1', 'TOKEN_CLASSIFICATION');

    expect(mockService.resolveRegistryModel).toHaveBeenCalledWith('medical-ner', 't-1', 'TOKEN_CLASSIFICATION');
    expect(result).toEqual({ slug: 'medical-ner', taskType: 'TOKEN_CLASSIFICATION' });
  });

  it('leaves taskType undefined when the caller sends none — it is a filter, not a requirement', async () => {
    mockService.resolveRegistryModel.mockResolvedValue({ slug: 'medical-ner' });

    await controller.resolveRegistryModel('medical-ner', 't-1');

    expect(mockService.resolveRegistryModel).toHaveBeenCalledWith('medical-ner', 't-1', undefined);
  });

  it('refuses a missing slug or tenantId with 400 before touching the service', async () => {
    await expect(controller.resolveRegistryModel(undefined, 't-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.resolveRegistryModel('medical-ner', undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockService.resolveRegistryModel).not.toHaveBeenCalled();
  });
});

describe('HarnessInternalController — models/resolve?taskKey', () => {
  let controller: HarnessInternalController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = build();
  });

  it('delegates (taskKey, tenantId) to the task-model resolve and returns its model', async () => {
    const model = { slug: 'medical-ner', taskType: 'TOKEN_CLASSIFICATION', sourceUri: 'blaze999/Medical-NER', localPath: null };
    mockService.resolveTaskModel.mockResolvedValue(model);

    const result = await controller.resolveRegistryModel(undefined, 't-1', undefined, 'nlp.ner');

    expect(mockService.resolveTaskModel).toHaveBeenCalledWith('nlp.ner', 't-1');
    expect(mockService.resolveRegistryModel).not.toHaveBeenCalled();
    expect(result).toBe(model);
  });

  it('refuses both slug and taskKey, or neither, with 400 before touching the service', async () => {
    await expect(controller.resolveRegistryModel('medical-ner', 't-1', undefined, 'nlp.ner')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.resolveRegistryModel(undefined, 't-1', undefined, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockService.resolveTaskModel).not.toHaveBeenCalled();
    expect(mockService.resolveRegistryModel).not.toHaveBeenCalled();
  });

  it('refuses a taskKey resolve without tenantId (400)', async () => {
    await expect(controller.resolveRegistryModel(undefined, undefined, undefined, 'nlp.ner')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockService.resolveTaskModel).not.toHaveBeenCalled();
  });

  it('surfaces the service 400 for a task key outside the allow-list', async () => {
    mockService.resolveTaskModel.mockRejectedValue(new BadRequestException("taskKey 'harness.judge' cannot be resolved by the harness worker."));

    await expect(controller.resolveRegistryModel(undefined, 't-1', undefined, 'harness.judge')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces the fail-closed 503 naming the key when no model is elected', async () => {
    mockService.resolveTaskModel.mockRejectedValue(new ServiceUnavailableException("SYSTEM routing election for 'nlp.ner' is missing"));

    await expect(controller.resolveRegistryModel(undefined, 't-1', undefined, 'nlp.ner')).rejects.toThrow("'nlp.ner'");
  });
});
