/**
 * TASK-946 D3 / OD-4 — the gateway half of the terminal-state fix.
 *
 * The watcher already recorded a run's terminal status; what it never did was act on a
 * CONSULTATION-bound run that ended badly. Measured 2026-09-10: 16 consultations left `DRAINING`
 * with their `WorkflowRun` rows still `RUNNING`, because (a) no watcher was attached for a
 * consultation-dispatched run at all, and (b) nothing closed the consultation when one failed.
 *
 * These tests pin (b) plus the DI declaration that makes (a) reachable from
 * `@arcaai/applications` without that package importing `apps/api`.
 */
import { describe, it, expect, vi } from 'vitest';
import { IWorkflowRunCompletionPort } from '@arcaai/applications';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';
import { WorkflowRunCompletionModule } from '../workflow-run-completion.module';

const TENANT = 'tenant-1';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af99e898';
const CONSULTATION = '01a08a8d-651c-0000-0000-000000000001';
const ENDED_AT = '2026-09-10T10:16:58.000Z';

function build() {
  const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
  const harnessInternal = { failGovernedRun: vi.fn().mockResolvedValue({ transitioned: true, status: 'CLOSED_INCOMPLETE' }) };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const service = new WorkflowRunCompletionService(
    runs as never,
    cls as never,
    { isRedisConfigured: () => false } as never,
    harnessInternal as never,
  );
  return { service, runs, harnessInternal };
}

describe('WorkflowRunCompletionService.recordTerminal (TASK-946)', () => {
  it('records the terminal status under the run tenant, for a consultation run', async () => {
    const { service, runs } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'FAILED', ENDED_AT, CONSULTATION);

    expect(runs.recordRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, runId: RUN_ID, status: 'FAILED', terminalReason: 'FAILED', consultationId: CONSULTATION }),
    );
    // Node counts are NOT invented here — the interpreter's `workflow.run.completed` payload
    // carries `status` (and a `reason`), never a stage summary (`activities.py::_envelope_for`).
    const [input] = runs.recordRunFinished.mock.calls[0]!;
    expect(input.failedNodeCount).toBeUndefined();
    expect(input.degradedNodeCount).toBeUndefined();
    expect(input.nodeCount).toBeUndefined();
  });

  it('closes the consultation when the run FAILED', async () => {
    const { service, harnessInternal } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'FAILED', ENDED_AT, CONSULTATION);

    expect(harnessInternal.failGovernedRun).toHaveBeenCalledWith(
      CONSULTATION,
      expect.objectContaining({ tenantId: TENANT, runId: RUN_ID, status: 'FAILED', reason: 'FAILED' }),
    );
  });

  it('closes the consultation when the run TIMED_OUT', async () => {
    const { service, harnessInternal } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'TIMED_OUT', 'TIMED_OUT', ENDED_AT, CONSULTATION);

    expect(harnessInternal.failGovernedRun).toHaveBeenCalledWith(CONSULTATION, expect.objectContaining({ status: 'TIMED_OUT' }));
  });

  it('leaves the consultation alone on a COMPLETED run — persistDraft/finalizeAssurance own success', async () => {
    const { service, harnessInternal, runs } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', ENDED_AT, CONSULTATION);

    expect(runs.recordRunFinished).toHaveBeenCalled();
    expect(harnessInternal.failGovernedRun).not.toHaveBeenCalled();
  });

  it('does nothing to any consultation for a run that is not consultation-bound', async () => {
    const { service, harnessInternal } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'FAILED', ENDED_AT, null);

    expect(harnessInternal.failGovernedRun).not.toHaveBeenCalled();
  });

  it('a failed consultation close never loses the run read-model write', async () => {
    const { service, runs, harnessInternal } = build();
    harnessInternal.failGovernedRun.mockRejectedValue(new Error('db down'));

    await expect(service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'FAILED', ENDED_AT, CONSULTATION)).resolves.toBeUndefined();

    expect(runs.recordRunFinished).toHaveBeenCalled();
  });

  it('a failed read-model write still closes the consultation — the two are independent', async () => {
    const { service, harnessInternal, runs } = build();
    runs.recordRunFinished.mockRejectedValue(new Error('row missing'));

    await expect(service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'FAILED', ENDED_AT, CONSULTATION)).resolves.toBeUndefined();

    expect(harnessInternal.failGovernedRun).toHaveBeenCalled();
  });
});

describe('WorkflowRunCompletionModule — the applications-side port (TASK-946 D3)', () => {
  it('is @Global(), so a provider in @arcaai/applications can resolve the port without importing apps/api', () => {
    expect(Reflect.getMetadata('__module:global__', WorkflowRunCompletionModule)).toBe(true);
  });

  it('binds IWorkflowRunCompletionPort to the watcher itself (one instance, not a second watcher)', () => {
    const providers = Reflect.getMetadata('providers', WorkflowRunCompletionModule) as { provide?: unknown; useExisting?: unknown }[];
    expect(providers).toContainEqual({ provide: IWorkflowRunCompletionPort, useExisting: WorkflowRunCompletionService });
  });

  it('exports both the port token and the service', () => {
    const exports = Reflect.getMetadata('exports', WorkflowRunCompletionModule) as unknown[];
    expect(exports).toContain(IWorkflowRunCompletionPort);
    expect(exports).toContain(WorkflowRunCompletionService);
  });
});
