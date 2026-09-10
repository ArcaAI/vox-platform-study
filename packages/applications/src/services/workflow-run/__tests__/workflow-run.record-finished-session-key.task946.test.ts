/**
 * TASK-946 D3 — `recordRunFinished` resolves a run under EITHER session key.
 *
 * A run reaches the read model under one of two session spellings: the exposure plane's
 * `workflow-interpreter-<runId>` or the consultation dispatcher's `wf-<runId>`. TASK-933 H3-5
 * taught `findRunOrThrow` both; `recordRunFinished` was left on a single `findByRunKey`, so the
 * terminal write for a consultation-governed run 404'd against a row that exists — measured
 * 2026-09-10 on `01a08a8d-65fb-742b-824e-1c94af99e898`, whose row is still `RUNNING`.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkflowRunFactory } from '@arcaai/domains';
import { WorkflowRunService, consultationDispatchSessionId, interpreterSessionId } from '../workflow-run.service';

const RUN_ID = 'run-1';

function build(rowSessionId: string) {
  const entity = WorkflowRunFactory.CreateRun({
    tenantId: 'tenant-1',
    workflowVersionId: 'def-1',
    workflowSlug: 'arcaai-consultation-v1',
    workflowVersionNumber: 2,
    definitionName: 'ArcaAI Consultation',
    sessionId: rowSessionId,
    runId: RUN_ID,
    trigger: 'consultation open',
    isSandbox: false,
    startedAt: new Date('2026-09-10T09:00:00.000Z'),
  });
  const repository = {
    findByRunKey: vi.fn().mockImplementation(async (_tenantId: string, sessionId: string) => (sessionId === rowSessionId ? entity : null)),
    create: vi.fn().mockImplementation(async (e: unknown) => e),
    updateWithVersion: vi.fn().mockImplementation(async (_id: string, e: unknown) => e),
  };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn().mockReturnValue(undefined) };
  return { service: new WorkflowRunService(repository as never, eventEmitter as never, cls as never), repository, entity };
}

describe('recordRunFinished — session-key fallback (TASK-946 D3)', () => {
  it('records the terminal status on a row anchored as wf-<runId> when told the interpreter key', async () => {
    const { service, entity } = build(consultationDispatchSessionId(RUN_ID));

    const response = await service.recordRunFinished({
      tenantId: 'tenant-1',
      sessionId: interpreterSessionId(RUN_ID),
      runId: RUN_ID,
      status: 'FAILED',
      endedAt: new Date('2026-09-10T10:16:58.000Z'),
      terminalReason: 'FAILED',
      consultationId: 'c-1',
    });

    expect(response.status).toBe('FAILED');
    expect(entity.endedAt?.toISOString()).toBe('2026-09-10T10:16:58.000Z');
  });

  it('still records a row anchored as workflow-interpreter-<runId> (the exposure plane, unchanged)', async () => {
    const { service } = build(interpreterSessionId(RUN_ID));

    const response = await service.recordRunFinished({
      tenantId: 'tenant-1',
      sessionId: interpreterSessionId(RUN_ID),
      runId: RUN_ID,
      status: 'COMPLETED',
    });

    expect(response.status).toBe('COMPLETED');
  });

  it('a run that exists under NEITHER key is still a 404', async () => {
    const { service } = build('some-other-session');

    await expect(
      service.recordRunFinished({ tenantId: 'tenant-1', sessionId: interpreterSessionId(RUN_ID), runId: RUN_ID, status: 'FAILED' }),
    ).rejects.toThrow(/not found/i);
  });
});
