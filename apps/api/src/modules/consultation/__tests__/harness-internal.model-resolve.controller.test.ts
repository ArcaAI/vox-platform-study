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
import { BadRequestException } from '@nestjs/common';
import { HarnessInternalController } from '../harness-internal.controller';

const mockService = { resolveRegistryModel: vi.fn() };

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
