/**
 * WorkflowTestFixtureController unit tests (TASK-721).
 *
 * CASL enforcement runs in the global UnifiedAuthGuard (e2e-covered); these
 * specs pin the controller's OWN contract: the class-level `@CanManage`
 * metadata, service delegation, and the If-Match → `expectedVersion` fold on
 * the OCC PATCH route. Mirrors `WebhookController`/`DepartmentController`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WorkflowTestFixtureController } from '../workflow-test-fixture.controller';

const fixtureResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 'fixture-1',
  name: 'Two-speaker follow-up visit',
  description: undefined,
  paletteId: undefined,
  workflowDefinitionId: undefined,
  input: { transcript: 'synthetic sample only' },
  resourceStatus: 'ENABLED',
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z',
  version: 1,
  ...overrides,
});

function makeController() {
  const workflowTestFixtureService = {
    create: vi.fn().mockResolvedValue(fixtureResponse()),
    findAll: vi.fn().mockResolvedValue({ data: [fixtureResponse()], count: 1, page: 0, limit: 10 }),
    findById: vi.fn().mockResolvedValue(fixtureResponse()),
    update: vi.fn().mockResolvedValue(fixtureResponse({ version: 2 })),
    deleteById: vi.fn().mockResolvedValue(fixtureResponse({ resourceStatus: 'DELETED' })),
  };
  const controller = new WorkflowTestFixtureController(workflowTestFixtureService as never);
  return { controller, workflowTestFixtureService };
}

describe('WorkflowTestFixtureController — authorization metadata', () => {
  it('mounts at admin/workflow-test-fixtures behind class-level manage:WorkflowTestFixture', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowTestFixtureController)).toBe('admin/workflow-test-fixtures');
    expect(Reflect.getMetadata('required_permissions', WorkflowTestFixtureController)).toEqual([
      { action: 'manage', subject: 'WorkflowTestFixture' },
    ]);
  });

  it('declares the OCC PATCH route (If-Match required)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowTestFixtureController.prototype.update)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, WorkflowTestFixtureController.prototype.update)).toBe(RequestMethod.PATCH);
  });
});

describe('WorkflowTestFixtureController — delegation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create delegates to the service and returns its response', async () => {
    const { controller, workflowTestFixtureService } = makeController();
    const request = { name: 'Two-speaker follow-up visit', input: { transcript: 'synthetic sample only' } };
    const result = await controller.create(request as never);
    expect(workflowTestFixtureService.create).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ id: 'fixture-1', name: 'Two-speaker follow-up visit' });
  });

  it('fetchAll delegates to the paginated list', async () => {
    const { controller, workflowTestFixtureService } = makeController();
    const result = await controller.fetchAll({ page: 0, limit: 10 } as never);
    expect(workflowTestFixtureService.findAll).toHaveBeenCalledWith({ page: 0, limit: 10 });
    expect(result.count).toBe(1);
  });

  it('fetchById delegates to the service', async () => {
    const { controller, workflowTestFixtureService } = makeController();
    const result = await controller.fetchById('fixture-1');
    expect(workflowTestFixtureService.findById).toHaveBeenCalledWith('fixture-1');
    expect(result.id).toBe('fixture-1');
  });

  it('update folds the If-Match header version over the body expectedVersion', async () => {
    const { controller, workflowTestFixtureService } = makeController();
    await controller.update('fixture-1', { name: 'renamed', expectedVersion: 1 } as never, 5);
    expect(workflowTestFixtureService.update).toHaveBeenCalledWith('fixture-1', { name: 'renamed', expectedVersion: 5 });
  });

  it('update falls back to the body expectedVersion without the header', async () => {
    const { controller, workflowTestFixtureService } = makeController();
    await controller.update('fixture-1', { name: 'renamed', expectedVersion: 1 } as never, undefined);
    expect(workflowTestFixtureService.update).toHaveBeenCalledWith('fixture-1', { name: 'renamed', expectedVersion: 1 });
  });

  it('delete delegates to the soft delete', async () => {
    const { controller, workflowTestFixtureService } = makeController();
    await controller.delete('fixture-1');
    expect(workflowTestFixtureService.deleteById).toHaveBeenCalledWith('fixture-1');
  });
});
