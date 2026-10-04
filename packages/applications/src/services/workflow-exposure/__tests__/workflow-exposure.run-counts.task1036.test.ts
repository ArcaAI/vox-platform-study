/**
 * TASK-1036 (lane B6b) — the status read path keeps the TASK-982 settled-node counts.
 *
 * Under run protocol v2 the terminal event no longer carries the counts. When the completion
 * watcher did not record them (no watcher: a restart, the per-process cap, Redis down) the row's
 * `nodeCount` stayed null — and `degraded` (computed from `degradedNodeCount`) read `false` for a
 * DEGRADED run. The status read now derives them from the harness state query's settled stages and
 * persists them with the terminal status; a row that already carries counts is left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowExposureService } from '../workflow-exposure.service';

const cls = { get: vi.fn(), set: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const harness = { getWorkflowRun: vi.fn() };
const runs = { getRun: vi.fn(), recordRunFinished: vi.fn() };
const config = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };

const STAGES = [
  { stage_index: 0, nodes: [{ node_id: 'a', node_type: 'core.trigger', status: 'COMPLETED' }] },
  { stage_index: 1, nodes: [{ node_id: 'b', node_type: 'core.agent', status: 'DEGRADED' }, { node_id: 'c', node_type: 'core.agent', status: 'SKIPPED' }] },
];

const row = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  sessionId: 'workflow-interpreter-run-1',
  workflowSlug: 'triage',
  workflowVersionNumber: 2,
  status: 'RUNNING',
  startedAt: null,
  endedAt: null,
  nodeCount: null,
  failedNodeCount: 0,
  degradedNodeCount: null,
  skippedNodeCount: null,
  ...over,
});

function service(): WorkflowExposureService {
  return new WorkflowExposureService({} as never, harness as never, runs as never, config as never, eventEmitter as never, cls as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
  runs.recordRunFinished.mockResolvedValue({});
});

describe('getRunStatus — counts from the harness stages when the row has none', () => {
  it('persists and returns them, so `degraded` is true for a DEGRADED run', async () => {
    runs.getRun.mockResolvedValue(row());
    harness.getWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'DEGRADED', stages: STAGES, startedAt: null, endedAt: '2026-10-04T10:00:00.000Z' });

    const status = await service().getRunStatus('triage', 'run-1');

    expect(runs.recordRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', status: 'COMPLETED', nodeCount: 3, failedNodeCount: 0, degradedNodeCount: 1, skippedNodeCount: 1 }),
    );
    expect(status).toMatchObject({ status: 'COMPLETED', nodeCount: 3, degradedNodeCount: 1, skippedNodeCount: 1, degraded: true });
  });

  it('leaves a row that already carries counts alone', async () => {
    runs.getRun.mockResolvedValue(row({ status: 'COMPLETED', nodeCount: 5, failedNodeCount: 0, degradedNodeCount: 0, skippedNodeCount: 2 }));
    harness.getWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'SUCCEEDED', stages: STAGES, startedAt: null, endedAt: null });

    const status = await service().getRunStatus('triage', 'run-1');

    expect(runs.recordRunFinished.mock.calls[0][0].nodeCount).toBeUndefined();
    expect(status).toMatchObject({ nodeCount: 5, skippedNodeCount: 2 });
  });

  it('a running run records nothing and reports no counts', async () => {
    runs.getRun.mockResolvedValue(row());
    harness.getWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'RUNNING', stages: STAGES, startedAt: null, endedAt: null });

    const status = await service().getRunStatus('triage', 'run-1');

    expect(runs.recordRunFinished).not.toHaveBeenCalled();
    expect(status.nodeCount).toBeNull();
  });
});
