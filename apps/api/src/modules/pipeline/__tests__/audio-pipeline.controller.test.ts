/**
 * AudioPipelineController — route metadata tests
 *
 * Covers TASK-263 / W0-9: the validate route must be `validate` (not the
 * legacy `validate-yaml`) so that `PIPELINE_ENDPOINTS.VALIDATE` in the SDK
 * (`/admin/audio/pipelines/validate`) resolves on the backend.
 *
 * We assert the runtime decorator metadata installed by `@Post(...)` on the
 * `validateYaml` handler rather than the source string, so the test fails
 * if a future refactor changes the route in either direction.
 */
import { describe, it, expect, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AudioPipelineController } from '../audio-pipeline.controller';
import { ValidateYamlRequest } from '../dto';

describe('AudioPipelineController route metadata (TASK-263 W0-9)', () => {
  it('class-level @Controller path stays admin/audio/pipelines', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController);
    expect(path).toBe('admin/audio/pipelines');
  });

  it('validateYaml handler is bound to HTTP path "validate"', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.validateYaml);
    expect(path).toBe('validate');
  });

  it('validateYaml handler is bound to HTTP POST', () => {
    const method = Reflect.getMetadata(METHOD_METADATA, AudioPipelineController.prototype.validateYaml);
    expect(method).toBe(RequestMethod.POST);
  });

  it('validateYaml handler must NOT be bound to the legacy "validate-yaml" path', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.validateYaml);
    expect(path).not.toBe('validate-yaml');
  });
});

// =============================================================================
// TASK-298 D-6 — validateConfig body field alignment
// =============================================================================
describe('AudioPipelineController validateYaml — TASK-298 D-6 body alignment', () => {
  const buildController = () => {
    const validateYaml = vi.fn().mockResolvedValue({ valid: true });
    const svc = { validateYaml } as any;
    return { controller: new AudioPipelineController(svc), validateYaml };
  };

  it('accepts `{ configYaml }` (SDK canonical field) and forwards its value', async () => {
    const { controller, validateYaml } = buildController();
    await controller.validateYaml({ configYaml: 'models:\n  asr: x' } as ValidateYamlRequest);
    expect(validateYaml).toHaveBeenCalledWith('models:\n  asr: x');
  });

  it('accepts `{ yaml }` (legacy field) and forwards its value', async () => {
    const { controller, validateYaml } = buildController();
    await controller.validateYaml({ yaml: 'models:\n  asr: y' } as ValidateYamlRequest);
    expect(validateYaml).toHaveBeenCalledWith('models:\n  asr: y');
  });

  it('rejects empty payloads via DTO validation', async () => {
    const dto = plainToInstance(ValidateYamlRequest, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// TASK-298 D-10 — narrower @Authorize on the admin controller
// =============================================================================
describe('AudioPipelineController authorization metadata — TASK-298 D-10', () => {
  it('uses [manage, AsrPipeline] (tenant admins can self-serve), not [manage, all]', () => {
    const meta = Reflect.getMetadata('required_permissions', AudioPipelineController);
    expect(meta).toBeDefined();
    expect(meta).toEqual(
      expect.arrayContaining([{ action: 'manage', subject: 'AsrPipeline' }]),
    );
    expect(JSON.stringify(meta)).not.toContain('"all"');
  });
});

// =============================================================================
// TASK-298 D-7 — assign-tenant endpoint
// =============================================================================
describe('AudioPipelineController assignTenant — TASK-298 D-7', () => {
  const buildController = () => {
    const getById = vi.fn();
    const svc = { getById } as any;
    return { controller: new AudioPipelineController(svc), getById };
  };

  it('exposes POST :id/assign-tenant', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.assignTenant);
    const method = Reflect.getMetadata(METHOD_METADATA, AudioPipelineController.prototype.assignTenant);
    expect(path).toBe(':id/assign-tenant');
    expect(method).toBe(RequestMethod.POST);
  });

  it('returns success when the pipeline belongs to the caller tenant', async () => {
    const { controller, getById } = buildController();
    getById.mockResolvedValue({ id: 'p-1', tenantId: 't-1' });

    const result = await controller.assignTenant('p-1', { tenantId: 't-target' });

    expect(result).toEqual(
      expect.objectContaining({ pipelineId: 'p-1', tenantId: 't-target' }),
    );
  });

  it('throws BadRequestException when pipeline is not in tenant scope', async () => {
    const { controller, getById } = buildController();
    getById.mockResolvedValue(null);

    await expect(controller.assignTenant('p-foreign', { tenantId: 't-x' })).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when tenantId is missing', async () => {
    const { controller } = buildController();
    await expect(controller.assignTenant('p-1', { tenantId: '   ' } as any)).rejects.toThrow(BadRequestException);
  });
});

// =============================================================================
// TASK-302 Stream D Phase E.4 — optimistic concurrency on PATCH
// =============================================================================
describe('AudioPipelineController update — TASK-302 Stream D Phase E.4', () => {
  const buildController = () => {
    const update = vi.fn();
    const svc = { update } as any;
    return { controller: new AudioPipelineController(svc), update };
  };

  it('forwards request unchanged when If-Match header is absent (body wins)', async () => {
    // In unit context the `RequiresIfMatchGuard` does not run; the
    // `@ExpectedVersion()` decorator therefore resolves to `undefined`
    // and the controller must pass the body through verbatim. The
    // global guard enforces 428 at the route level — that is covered by
    // dedicated decorator/guard tests, not here.
    const { controller, update } = buildController();
    update.mockResolvedValue({ id: 'p-1', name: 'Updated', version: 8 });

    await controller.update('p-1', { name: 'Updated', expectedVersion: 7 } as any, undefined);

    expect(update).toHaveBeenCalledWith('p-1', { name: 'Updated', expectedVersion: 7 });
  });

  it('folds the If-Match header into the body-field expectedVersion (header wins)', async () => {
    const { controller, update } = buildController();
    update.mockResolvedValue({ id: 'p-1', name: 'Updated', version: 8 });

    await controller.update('p-1', { name: 'Updated', expectedVersion: 99 } as any, 7);

    expect(update).toHaveBeenCalledWith(
      'p-1',
      expect.objectContaining({
        name: 'Updated',
        expectedVersion: 7,
      }),
    );
  });

  it('returns the service result (including the bumped version) verbatim', async () => {
    const { controller, update } = buildController();
    update.mockResolvedValue({ id: 'p-1', name: 'Updated', version: 8 });

    const result = await controller.update('p-1', { name: 'Updated', expectedVersion: 7 } as any, undefined);

    expect(result).toEqual(expect.objectContaining({ id: 'p-1', version: 8 }));
  });
});
