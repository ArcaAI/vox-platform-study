/**
 * TASK-864 (owner decision D-5) — `recordRunFinished` emits ONE `WorkflowRun` sys-event with a
 * PHI-free payload so a run-completed webhook can fan out; `recordRunStarted` still emits none.
 */
import { describe, it, expect, vi } from 'vitest';
import { ResourceType, SysEventType, WorkflowRunFactory } from '@arcaai/domains';
import { WorkflowRunService } from '../workflow-run.service';

function build() {
  const entity = WorkflowRunFactory.CreateRun({
    tenantId: 'tenant-1',
    workflowVersionId: 'def-1',
    workflowSlug: 'triage',
    workflowVersionNumber: 2,
    definitionName: 'Triage',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'webhook',
    isSandbox: false,
    startedAt: new Date('2026-09-04T00:00:00.000Z'),
  });
  const repository = {
    findByRunKey: vi.fn().mockResolvedValue(entity),
    create: vi.fn().mockImplementation(async (e: unknown) => e),
    updateWithVersion: vi.fn().mockImplementation(async (_id: string, e: unknown) => e),
  };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn().mockReturnValue(undefined) };
  const service = new WorkflowRunService(repository as never, eventEmitter as never, cls as never);
  return { service, eventEmitter, repository };
}

describe('recordRunFinished — the run-completed sys-event', () => {
  it('broadcasts ResourceUpdated on ResourceType.WorkflowRun with identifiers only', async () => {
    const { service, eventEmitter } = build();
    await service.recordRunFinished({ tenantId: 'tenant-1', sessionId: 'workflow-interpreter-run-1', runId: 'run-1', status: 'COMPLETED', endedAt: new Date('2026-09-04T00:01:00.000Z'), terminalReason: 'SUCCEEDED', consultationId: 'c-1', resultRef: { outputs: { note: 'PHI here' } } });
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [type, event] = eventEmitter.emit.mock.calls[0]!;
    expect(type).toBe(SysEventType.ResourceUpdated);
    expect(event.resourceType).toBe(ResourceType.WorkflowRun);
    expect(event.data).toEqual({
      action: 'runFinished',
      runId: 'run-1',
      slug: 'triage',
      workflowVersionNumber: 2,
      status: 'COMPLETED',
      terminalReason: 'SUCCEEDED',
      startedAt: '2026-09-04T00:00:00.000Z',
      endedAt: '2026-09-04T00:01:00.000Z',
      consultationId: 'c-1',
    });
    expect(JSON.stringify(event.data)).not.toContain('PHI here');
  });

  it('recordRunStarted still emits nothing', async () => {
    const { service, eventEmitter, repository } = build();
    repository.findByRunKey.mockResolvedValue(null);
    await service.recordRunStarted({ tenantId: 'tenant-1', workflowVersionId: 'def-1', workflowSlug: 'triage', workflowVersionNumber: 2, definitionName: 'Triage', sessionId: 's', runId: 'run-2', trigger: 'api invoke' });
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
