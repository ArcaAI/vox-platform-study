import { describe, it, expect, vi } from 'vitest';
import { WorkflowSandboxRunService } from '../workflow-sandbox-run.service';

const compiled = {
  compiledConfig: { formatVersion: 1, stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n1', type: 'noop', activity: 'interpreter.noop', config: {} }] }], gates: [] },
  workflowVersionId: 'def-1',
  workflowSlug: 'slug',
  workflowVersionNumber: 1,
  definitionName: 'Def',
};

function build(recordRunFinished = vi.fn().mockResolvedValue(undefined)) {
  const harness = { startWorkflowRun: vi.fn().mockRejectedValue(new Error('harness down with PHI-ish text')) };
  const runs = { recordRunStarted: vi.fn().mockResolvedValue(undefined), recordRunFinished };
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : undefined)), set: vi.fn() };
  const service = new WorkflowSandboxRunService(
    { getCompiledConfigForSandboxRun: vi.fn().mockResolvedValue(compiled) } as never,
    { findById: vi.fn() } as never,
    harness as never,
    runs as never,
    { emit: vi.fn() } as never,
    cls as never,
    { putFile: vi.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, runs };
}

describe('startRun when the harness start throws', () => {
  it('marks the already-written run FAILED with a code (no message) and rethrows the original error', async () => {
    const { service, runs } = build();
    await expect(service.startRun('def-1', {})).rejects.toThrow('harness down');
    expect(runs.recordRunFinished).toHaveBeenCalledTimes(1);
    const arg = runs.recordRunFinished.mock.calls[0]![0];
    expect(arg).toMatchObject({ tenantId: 'tenant-1', status: 'FAILED', firstErrorCode: 'RUN_START_FAILED' });
    expect(JSON.stringify(arg)).not.toContain('PHI-ish');
  });

  it('still rethrows the start error when marking the row fails', async () => {
    const { service } = build(vi.fn().mockRejectedValue(new Error('db down')));
    await expect(service.startRun('def-1', {})).rejects.toThrow('harness down');
  });
});
