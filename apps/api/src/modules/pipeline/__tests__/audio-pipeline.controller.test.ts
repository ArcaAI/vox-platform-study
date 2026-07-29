/**
 * AudioPipelineController — route metadata tests
 *
 * The validate route must be `validate` (not the legacy `validate-yaml`) so
 * that `PIPELINE_ENDPOINTS.VALIDATE` in the SDK
 * (`/admin/audio/pipelines/validate`) resolves on the backend.
 *
 * We assert the runtime decorator metadata installed by `@Post(...)` on the
 * `validateYaml` handler rather than the source string, so the test fails
 * if a future refactor changes the route in either direction.
 */
import { describe, it, expect, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { BadRequestException, NotFoundException, RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AudioPipelineController } from '../audio-pipeline.controller';
import { ValidateYamlRequest } from '../dto';

describe('AudioPipelineController route metadata', () => {
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
// IC-02 — admin list returns ALL statuses (so disabled pipelines stay visible)
// =============================================================================
describe('AudioPipelineController fetchAll — IC-02 admin all-status list', () => {
  it('delegates the admin list to getAllForAdmin (all statuses), not the enabled-only getAll', async () => {
    const getAllForAdmin = vi.fn().mockResolvedValue([
      { id: 'p1', resourceStatus: 'ENABLED' },
      { id: 'p2', resourceStatus: 'DISABLED' },
    ]);
    const getAll = vi.fn().mockResolvedValue([]);
    const controller = new AudioPipelineController({ getAllForAdmin, getAll } as any);

    const result = await controller.fetchAll();

    expect(getAllForAdmin).toHaveBeenCalledTimes(1);
    // The enabled-only query (shared with the public controller) must not be
    // what backs the admin surface — that is what hid disabled pipelines.
    expect(getAll).not.toHaveBeenCalled();
    expect(result.map((p) => p.resourceStatus)).toContain('DISABLED');
  });
});

describe('AudioPipelineController validateYaml — body alignment', () => {
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

describe('AudioPipelineController authorization metadata', () => {
  it('uses [manage, AsrPipeline] (tenant admins can self-serve), not [manage, all]', () => {
    const meta = Reflect.getMetadata('required_permissions', AudioPipelineController);
    expect(meta).toBeDefined();
    expect(meta).toEqual(expect.arrayContaining([{ action: 'manage', subject: 'AsrPipeline' }]));
    expect(JSON.stringify(meta)).not.toContain('"all"');
  });
});

describe('AudioPipelineController assignTenant', () => {
  const buildController = () => {
    const assignToTenant = vi.fn();
    const svc = { assignToTenant } as any;
    return { controller: new AudioPipelineController(svc), assignToTenant };
  };

  it('exposes POST :id/assign-tenant', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.assignTenant);
    const method = Reflect.getMetadata(METHOD_METADATA, AudioPipelineController.prototype.assignTenant);
    expect(path).toBe(':id/assign-tenant');
    expect(method).toBe(RequestMethod.POST);
  });

  // IC-04 — the handler must delegate real persistence to the service (which
  // promotes the pipeline to the tenant default) instead of echoing success.
  it('delegates persistence to the service and maps the assignment response', async () => {
    const { controller, assignToTenant } = buildController();
    assignToTenant.mockResolvedValue({ id: 'p-1', isDefault: true });

    const result = await controller.assignTenant('p-1', { tenantId: 't-1' });

    expect(assignToTenant).toHaveBeenCalledWith('p-1', 't-1');
    expect(result).toEqual(expect.objectContaining({ pipelineId: 'p-1', tenantId: 't-1' }));
    expect(typeof result.message).toBe('string');
  });

  it('propagates the service rejection for a cross-tenant target (no fake success)', async () => {
    const { controller, assignToTenant } = buildController();
    assignToTenant.mockRejectedValue(new BadRequestException('Cross-tenant pipeline assignment is not supported'));

    await expect(controller.assignTenant('p-1', { tenantId: 't-other' })).rejects.toThrow(BadRequestException);
    expect(assignToTenant).toHaveBeenCalledWith('p-1', 't-other');
  });
});

describe('AudioPipelineController update', () => {
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

describe('AudioPipelineController — default/toggle/versions', () => {
  const buildController = () => {
    const svc = {
      setDefault: vi.fn(),
      toggle: vi.fn(),
      listVersions: vi.fn(),
      getVersion: vi.fn(),
    } as any;
    return { controller: new AudioPipelineController(svc), svc };
  };

  it('exposes POST :id/set-default and delegates to the service', async () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.setDefault);
    const method = Reflect.getMetadata(METHOD_METADATA, AudioPipelineController.prototype.setDefault);
    expect(path).toBe(':id/set-default');
    expect(method).toBe(RequestMethod.POST);

    const { controller, svc } = buildController();
    svc.setDefault.mockResolvedValue({ id: 'p-1', isDefault: true });
    const result = await controller.setDefault('p-1');
    expect(svc.setDefault).toHaveBeenCalledWith('p-1');
    expect(result).toEqual(expect.objectContaining({ isDefault: true }));
  });

  it('exposes PATCH :id/toggle and folds the If-Match version into the service call', async () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.toggle);
    const method = Reflect.getMetadata(METHOD_METADATA, AudioPipelineController.prototype.toggle);
    expect(path).toBe(':id/toggle');
    expect(method).toBe(RequestMethod.PATCH);

    const { controller, svc } = buildController();
    svc.toggle.mockResolvedValue({ id: 'p-1', resourceStatus: 'DISABLED', version: 6 });
    await controller.toggle('p-1', { enabled: false }, 5);
    expect(svc.toggle).toHaveBeenCalledWith('p-1', false, 5);
  });

  it('exposes GET :id/versions and returns the snapshot list', async () => {
    const path = Reflect.getMetadata(PATH_METADATA, AudioPipelineController.prototype.listVersions);
    const method = Reflect.getMetadata(METHOD_METADATA, AudioPipelineController.prototype.listVersions);
    expect(path).toBe(':id/versions');
    expect(method).toBe(RequestMethod.GET);

    const { controller, svc } = buildController();
    svc.listVersions.mockResolvedValue([{ versionNumber: 2 }, { versionNumber: 1 }]);
    const result = await controller.listVersions('p-1');
    expect(svc.listVersions).toHaveBeenCalledWith('p-1');
    expect(result).toHaveLength(2);
  });

  it('GET :id/versions/:versionNumber parses the number and returns the snapshot', async () => {
    const { controller, svc } = buildController();
    svc.getVersion.mockResolvedValue({ versionNumber: 2 });
    const result = await controller.getVersion('p-1', '2');
    expect(svc.getVersion).toHaveBeenCalledWith('p-1', 2);
    expect(result).toEqual(expect.objectContaining({ versionNumber: 2 }));
  });

  it('GET :id/versions/:versionNumber throws NotFound when the version is absent', async () => {
    const { controller, svc } = buildController();
    svc.getVersion.mockResolvedValue(null);
    await expect(controller.getVersion('p-1', '99')).rejects.toThrow(NotFoundException);
  });

  it('GET :id/versions/:versionNumber throws BadRequest for a non-positive version', async () => {
    const { controller } = buildController();
    await expect(controller.getVersion('p-1', '0')).rejects.toThrow(BadRequestException);
  });
});
