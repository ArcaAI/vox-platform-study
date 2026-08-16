/**
 * WorkflowNodeController unit tests (TASK-734).
 *
 * CASL enforcement runs in the global UnifiedAuthGuard (e2e-covered); these specs pin the
 * controller's OWN contract: the class-level `@CanRead` metadata and service delegation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { WorkflowNodeController } from '../workflow-node.controller';

function makeController() {
  const workflowDefinitionService = {
    listNodes: vi.fn().mockResolvedValue({
      nodes: [
        { type: 'noop', implemented: true, activityName: 'interpreter.noop', classes: [], paletteKey: null, critical: false, externalWrite: false, defaultTimeoutSeconds: 60, defaultMaxAttempts: 1, entitlementKey: null },
        { type: 'passthrough', implemented: true, activityName: 'interpreter.passthrough', classes: [], paletteKey: null, critical: false, externalWrite: false, defaultTimeoutSeconds: 60, defaultMaxAttempts: 1, entitlementKey: null },
      ],
      registryChecksum: 'a'.repeat(64),
    }),
  };
  const controller = new WorkflowNodeController(workflowDefinitionService as never);
  return { controller, workflowDefinitionService };
}

describe('WorkflowNodeController — authorization metadata', () => {
  it('mounts at admin/workflow-nodes behind class-level read:WorkflowDefinition', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowNodeController)).toBe('admin/workflow-nodes');
    expect(Reflect.getMetadata('required_permissions', WorkflowNodeController)).toEqual([{ action: 'read', subject: 'WorkflowDefinition' }]);
  });
});

describe('WorkflowNodeController — delegation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetchAll delegates to listNodes and returns its response verbatim', async () => {
    const { controller, workflowDefinitionService } = makeController();
    const result = await controller.fetchAll();
    expect(workflowDefinitionService.listNodes).toHaveBeenCalledTimes(1);
    expect(result.nodes.map((n) => n.type)).toEqual(['noop', 'passthrough']);
    expect(result.registryChecksum).toBe('a'.repeat(64));
  });
});
