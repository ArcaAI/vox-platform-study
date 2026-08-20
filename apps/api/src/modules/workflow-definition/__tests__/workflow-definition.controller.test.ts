/**
 * WorkflowDefinitionController unit tests (TASK-734).
 *
 * CASL enforcement runs in the global UnifiedAuthGuard (e2e-covered); these specs pin the
 * controller's OWN contract: the class-level `@CanManage` metadata, service delegation, and
 * the If-Match → `expectedVersion` fold on the OCC PATCH route. Mirrors
 * `WorkflowTestFixtureController`'s test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { WorkflowDefinitionController } from '../workflow-definition.controller';

const definitionResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  status: 'DRAFT',
  versionNumber: 1,
  version: 1,
  ...overrides,
});

function makeController() {
  const workflowDefinitionService = {
    create: vi.fn().mockResolvedValue(definitionResponse()),
    list: vi.fn().mockResolvedValue({ data: [definitionResponse()], count: 1, page: 0, limit: 10 }),
    getById: vi.fn().mockResolvedValue(definitionResponse()),
    listVersions: vi.fn().mockResolvedValue([definitionResponse({ versionNumber: 2 }), definitionResponse({ versionNumber: 1 })]),
    update: vi.fn().mockResolvedValue(definitionResponse({ version: 2 })),
    deleteById: vi.fn().mockResolvedValue(definitionResponse({ resourceStatus: 'DELETED' })),
    validate: vi.fn().mockResolvedValue(definitionResponse({ status: 'VALIDATED' })),
    publish: vi.fn().mockResolvedValue(definitionResponse({ status: 'PUBLISHED' })),
  };
  const controller = new WorkflowDefinitionController(workflowDefinitionService as never);
  return { controller, workflowDefinitionService };
}

describe('WorkflowDefinitionController — authorization metadata', () => {
  it('mounts at admin/workflow-definitions behind class-level manage:WorkflowDefinition', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowDefinitionController)).toBe('admin/workflow-definitions');
    expect(Reflect.getMetadata('required_permissions', WorkflowDefinitionController)).toEqual([
      { action: 'manage', subject: 'WorkflowDefinition' },
    ]);
  });

  it('declares the OCC PATCH route (If-Match required)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowDefinitionController.prototype.update)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, WorkflowDefinitionController.prototype.update)).toBe(RequestMethod.PATCH);
  });

  it('declares validate/publish as POST sub-routes (not OCC — no If-Match metadata)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowDefinitionController.prototype.validate)).toBe(':id/validate');
    expect(Reflect.getMetadata(METHOD_METADATA, WorkflowDefinitionController.prototype.validate)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowDefinitionController.prototype.publish)).toBe(':id/publish');
    expect(Reflect.getMetadata(METHOD_METADATA, WorkflowDefinitionController.prototype.publish)).toBe(RequestMethod.POST);
  });

  it('answers validate/publish with 200, not Nest\'s default 201 for POST (TASK-780 F-2)', () => {
    // These are state transitions on an EXISTING resource (DRAFT -> VALIDATED /
    // DRAFT -> PUBLISHED), not creations of a new one — the documented
    // `@ApiResponse({ status: 200 })` (and openapi.json) is the correct contract,
    // so the handler must override Nest's default POST status (201) explicitly.
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WorkflowDefinitionController.prototype.validate)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WorkflowDefinitionController.prototype.publish)).toBe(200);
  });
});

describe('WorkflowDefinitionController — delegation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create delegates to the service and returns its response', async () => {
    const { controller, workflowDefinitionService } = makeController();
    const request = { slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: { version: 1, nodes: [], edges: [] } };
    const result = await controller.create(request as never);
    expect(workflowDefinitionService.create).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ id: 'def-1', slug: 'discharge_summary' });
  });

  it('fetchAll delegates to the paginated list', async () => {
    const { controller, workflowDefinitionService } = makeController();
    const result = await controller.fetchAll({ page: 0, limit: 10 } as never);
    expect(workflowDefinitionService.list).toHaveBeenCalledWith({ page: 0, limit: 10 });
    expect(result.count).toBe(1);
  });

  it('fetchById delegates to the service', async () => {
    const { controller, workflowDefinitionService } = makeController();
    const result = await controller.fetchById('def-1');
    expect(workflowDefinitionService.getById).toHaveBeenCalledWith('def-1');
    expect(result.id).toBe('def-1');
  });

  it('fetchVersions delegates to the service', async () => {
    const { controller, workflowDefinitionService } = makeController();
    const result = await controller.fetchVersions('def-1');
    expect(workflowDefinitionService.listVersions).toHaveBeenCalledWith('def-1');
    expect(result.map((r) => r.versionNumber)).toEqual([2, 1]);
  });

  it('update folds the If-Match header version over the body expectedVersion', async () => {
    const { controller, workflowDefinitionService } = makeController();
    await controller.update('def-1', { name: 'renamed', expectedVersion: 1 } as never, 5);
    expect(workflowDefinitionService.update).toHaveBeenCalledWith('def-1', { name: 'renamed', expectedVersion: 5 });
  });

  it('update falls back to the body expectedVersion without the header', async () => {
    const { controller, workflowDefinitionService } = makeController();
    await controller.update('def-1', { name: 'renamed', expectedVersion: 1 } as never, undefined);
    expect(workflowDefinitionService.update).toHaveBeenCalledWith('def-1', { name: 'renamed', expectedVersion: 1 });
  });

  it('delete delegates to the soft delete', async () => {
    const { controller, workflowDefinitionService } = makeController();
    await controller.delete('def-1');
    expect(workflowDefinitionService.deleteById).toHaveBeenCalledWith('def-1');
  });

  it('validate delegates to the service', async () => {
    const { controller, workflowDefinitionService } = makeController();
    const result = await controller.validate('def-1');
    expect(workflowDefinitionService.validate).toHaveBeenCalledWith('def-1');
    expect(result.status).toBe('VALIDATED');
  });

  it('publish delegates to the service, defaulting an undefined body to {}', async () => {
    const { controller, workflowDefinitionService } = makeController();
    const result = await controller.publish('def-1', undefined as never);
    expect(workflowDefinitionService.publish).toHaveBeenCalledWith('def-1', {});
    expect(result.status).toBe('PUBLISHED');
  });

  it('publish forwards an explicit activate flag', async () => {
    const { controller, workflowDefinitionService } = makeController();
    await controller.publish('def-1', { activate: false });
    expect(workflowDefinitionService.publish).toHaveBeenCalledWith('def-1', { activate: false });
  });
});
