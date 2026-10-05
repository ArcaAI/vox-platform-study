/**
 * TASK-1045 e2e (E2E-8) — every FAILED / TIMED_OUT run row carries a non-empty `firstErrorCode`.
 *
 * Live e2e 2026-10-05: the governed run `arcaai-bren-consultation` (consultation open) ended
 * FAILED with `failedNodeCount 1` and `firstErrorCode` NULL — the completion watcher closes the row
 * and never passed a code, so the read model could not say why the run failed. A caller that
 * names a code wins; a terminal failure with none gets the generic code for its status; a code
 * already on the row is never cleared by a later writer that has none.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunFactory } from '@arcaai/domains';
import { WorkflowRunService, interpreterSessionId } from '../workflow-run.service';

const TENANT = 'tenant-1';
const RUN_ID = 'run-1';
const SESSION_ID = interpreterSessionId(RUN_ID);

function buildRun(firstErrorCode?: string) {
  const run = WorkflowRunFactory.CreateRun({
    tenantId: TENANT,
    workflowVersionId: 'wfv-1',
    workflowSlug: 'arcaai-bren-consultation',
    workflowVersionNumber: 1,
    definitionName: 'Bren consultation',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    trigger: 'consultation open',
    startedAt: new Date('2026-10-05T18:41:30.410Z'),
  });
  if (firstErrorCode) run.firstErrorCode = firstErrorCode;
  return run;
}

function build(run: ReturnType<typeof buildRun>) {
  const repository = {
    findByRunKey: vi.fn().mockResolvedValue(run),
    updateWithVersion: vi.fn().mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity)),
  };
  const service = new WorkflowRunService(repository as never, { emit: vi.fn() } as never, { get: vi.fn() } as never);
  return { service, repository };
}

describe('recordRunFinished — a failed run always names a code', () => {
  it('a FAILED finish with no code stamps RUN_FAILED', async () => {
    const run = buildRun();
    const { service } = build(run);

    const out = await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'FAILED', failedNodeCount: 1 });

    expect(run.firstErrorCode).toBe('RUN_FAILED');
    expect(out.firstErrorCode).toBe('RUN_FAILED');
  });

  it('a TIMED_OUT finish with no code stamps RUN_TIMED_OUT', async () => {
    const run = buildRun();
    const { service } = build(run);

    await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'TIMED_OUT' });

    expect(run.firstErrorCode).toBe('RUN_TIMED_OUT');
  });

  it("the caller's code wins", async () => {
    const run = buildRun();
    const { service } = build(run);

    await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'FAILED', firstErrorCode: 'OUTPUT_INVALID' });

    expect(run.firstErrorCode).toBe('OUTPUT_INVALID');
  });

  it('a later writer with no code keeps the code already on the row', async () => {
    const run = buildRun('OUTPUT_INVALID');
    const { service } = build(run);

    await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'FAILED' });

    expect(run.firstErrorCode).toBe('OUTPUT_INVALID');
  });

  it('a COMPLETED or CANCELED finish stamps nothing', async () => {
    for (const status of ['COMPLETED', 'CANCELED'] as const) {
      const run = buildRun();
      const { service } = build(run);

      await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status });

      expect(run.firstErrorCode ?? null).toBeNull();
    }
  });
});
