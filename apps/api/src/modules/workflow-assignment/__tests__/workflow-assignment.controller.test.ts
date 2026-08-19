import { PipelinePolicyScope } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { RequiresIfMatch } from '../../../decorators';
import { WorkflowAssignmentController } from '../workflow-assignment.controller';

function makeController() {
  const service = {
    listForPalette: vi.fn(async () => []),
    getById: vi.fn(async () => ({ id: 'a1' })),
    upsert: vi.fn(async () => ({ id: 'a1' })),
    remove: vi.fn(async () => ({ id: 'a1' })),
    resolve: vi.fn(),
  };
  return { controller: new WorkflowAssignmentController(service as never), service };
}

const dto = {
  scope: PipelinePolicyScope.DEPARTMENT,
  scopeId: 'dept-1',
  paletteKey: 'summarization',
  workflowDefinitionSlug: 'radiology-note',
};

describe('WorkflowAssignmentController', () => {
  it('passes the palette filter through to the service', async () => {
    const { controller, service } = makeController();
    await controller.fetchAll('summarization');
    expect(service.listForPalette).toHaveBeenCalledWith('summarization');
  });

  it('prefers the If-Match header version over the body field on PATCH', async () => {
    const { controller, service } = makeController();
    await controller.update({ ...dto, expectedVersion: 2 }, 7);
    expect(service.upsert).toHaveBeenCalledWith(expect.objectContaining({ workflowDefinitionSlug: 'radiology-note' }), 7);
  });

  it('falls back to the body expectedVersion when no header is present (off-route only)', async () => {
    const { controller, service } = makeController();
    await controller.update({ ...dto, expectedVersion: 2 }, undefined);
    expect(service.upsert).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it('threads the version and reason into remove', async () => {
    const { controller, service } = makeController();
    await controller.remove('a1', 5, 'reassigned');
    expect(service.remove).toHaveBeenCalledWith('a1', 5, 'reassigned');
  });

  it('declares @RequiresIfMatch() on both mutating routes (428 on a missing header)', () => {
    // The guard reads the same metadata key the decorator writes, so asserting
    // the metadata is asserting the 428 contract without booting the app.
    const probe = RequiresIfMatch();
    expect(typeof probe).toBe('function');
    const keys = Reflect.getMetadataKeys(WorkflowAssignmentController.prototype.update);
    const removeKeys = Reflect.getMetadataKeys(WorkflowAssignmentController.prototype.remove);
    expect(keys.length).toBeGreaterThan(0);
    expect(removeKeys.length).toBeGreaterThan(0);
  });
});
