/**
 * The COMPLETED half of the governing-run marker.
 *
 * `failGovernedRun` already records a run that ended badly. A run that ended WELL left the marker
 * saying `RUNNING` forever, so every consultation surface reported an in-flight run for a
 * consultation whose note had long since been written — and nothing anywhere carried the
 * `degraded` flag the node counts make available.
 *
 * The write is delegated to `@arcaai/applications`: this package must not reach into
 * `Consultation.metadata` itself, because the marker's shape is that package's business and a
 * second writer would eventually disagree with `governingRunOf` about what a field means.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';

const TENANT = 'tenant-1';
const RUN_ID = '01a08a8d-65fb-742b-824e-1c94af99e898';
const CONSULTATION = '01a08a8d-651c-0000-0000-000000000001';
const ENDED_AT = '2026-09-17T10:16:58.000Z';

function build() {
  const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
  const harnessInternal = {
    failGovernedRun: vi.fn().mockResolvedValue({ transitioned: true, status: 'CLOSED_INCOMPLETE' }),
    recordGovernedRunCompleted: vi.fn().mockResolvedValue(undefined),
  };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const service = new WorkflowRunCompletionService(
    runs as never,
    cls as never,
    { isRedisConfigured: () => false } as never,
    harnessInternal as never,
  );
  return { service, runs, harnessInternal };
}

describe('a COMPLETED consultation run reaches the governing-engine marker', () => {
  it('stamps COMPLETED with the run end time', async () => {
    const { service, harnessInternal } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', ENDED_AT, CONSULTATION, { nodeCount: 5, failedNodeCount: 0 });

    expect(harnessInternal.recordGovernedRunCompleted).toHaveBeenCalledWith(
      CONSULTATION,
      expect.objectContaining({ tenantId: TENANT, runId: RUN_ID, degraded: false, at: new Date(ENDED_AT) }),
    );
    expect(harnessInternal.failGovernedRun).not.toHaveBeenCalled();
  });

  it('derives `degraded` from the counts — a degraded OR a skipped node sets it', async () => {
    for (const counts of [{ degradedNodeCount: 2 }, { skippedNodeCount: 1 }, { degradedNodeCount: 1, skippedNodeCount: 3 }]) {
      const { service, harnessInternal } = build();

      await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'DEGRADED', ENDED_AT, CONSULTATION, { nodeCount: 5, ...counts });

      expect(harnessInternal.recordGovernedRunCompleted).toHaveBeenCalledWith(CONSULTATION, expect.objectContaining({ degraded: true }));
    }
  });

  it('reads ABSENT counts as not-degraded — an older interpreter build never claims warnings', async () => {
    const { service, harnessInternal } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', ENDED_AT, CONSULTATION);

    expect(harnessInternal.recordGovernedRunCompleted).toHaveBeenCalledWith(CONSULTATION, expect.objectContaining({ degraded: false }));
  });

  it('touches no consultation for a run that is not consultation-bound', async () => {
    const { service, harnessInternal } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', ENDED_AT, null, { degradedNodeCount: 1 });

    expect(harnessInternal.recordGovernedRunCompleted).not.toHaveBeenCalled();
  });

  it('does not stamp COMPLETED for CANCELED — whoever cancelled the run owns what happens next', async () => {
    const { service, harnessInternal } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'CANCELED', 'CANCELED', ENDED_AT, CONSULTATION);

    expect(harnessInternal.recordGovernedRunCompleted).not.toHaveBeenCalled();
    expect(harnessInternal.failGovernedRun).not.toHaveBeenCalled();
  });

  it('still records the run row when the marker write fails — two independent systems of record', async () => {
    const { service, runs, harnessInternal } = build();
    harnessInternal.recordGovernedRunCompleted.mockRejectedValue(new Error('database unavailable'));

    await expect(service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', ENDED_AT, CONSULTATION)).resolves.toBeUndefined();

    expect(runs.recordRunFinished).toHaveBeenCalled();
  });

  it('works against a gateway with no harness-internal plane wired', async () => {
    const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
    const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
    const service = new WorkflowRunCompletionService(runs as never, cls as never, { isRedisConfigured: () => false } as never, undefined);

    await expect(service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'SUCCEEDED', ENDED_AT, CONSULTATION)).resolves.toBeUndefined();
  });
});
