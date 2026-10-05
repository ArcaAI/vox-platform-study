/**
 * TASK-1045 e2e (E2E-8) — the completion watcher records the run's own error code on the row.
 *
 * A v2 `run.failed` names `error.code` (`OUTPUT_INVALID`, `MODEL_ERROR`, …) and the watcher handed it
 * to `recordTerminal` as `reason` — then dropped it, so a FAILED governed run kept a NULL
 * `firstErrorCode`. It is now passed through when it is a code; a bare status word (the harness
 * re-check and pre-v2 paths report the status itself) is not a code, and the read model's generic
 * code applies instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const RUN_ID = '01a10d5e-f929-7e5f-8286-fec21a6ceb56';
const AT = '2026-10-05T18:42:54.924Z';

function build() {
  const runs = { recordRunFinished: vi.fn().mockResolvedValue({}) };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const service = new WorkflowRunCompletionService(runs as never, cls as never);
  return { service, runs };
}

describe('recordTerminal — the failed run names its code', () => {
  it("passes a v2 run.failed error code as the row's firstErrorCode", async () => {
    const { service, runs } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'OUTPUT_INVALID', AT, null, { failedNodeCount: 1 });

    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED', firstErrorCode: 'OUTPUT_INVALID' }));
  });

  it('a TIMED_OUT run passes its code too', async () => {
    const { service, runs } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'TIMED_OUT', 'RUN_TIMED_OUT', AT, null);

    expect(runs.recordRunFinished.mock.calls[0][0].firstErrorCode).toBe('RUN_TIMED_OUT');
  });

  it('a bare status word is not a code', async () => {
    const { service, runs } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'FAILED', AT, null);

    expect(runs.recordRunFinished.mock.calls[0][0].firstErrorCode).toBeUndefined();
  });

  it('free text is never written as a code', async () => {
    const { service, runs } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'FAILED', 'core.output: result violates the declared output schema', AT, null);

    expect(runs.recordRunFinished.mock.calls[0][0].firstErrorCode).toBeUndefined();
  });

  it('a COMPLETED or CANCELED run passes no code', async () => {
    const { service, runs } = build();

    await service.recordTerminal(TENANT, RUN_ID, 'COMPLETED', 'COMPLETED', AT, null);
    await service.recordTerminal(TENANT, RUN_ID, 'CANCELED', 'CANCELLED_BY_CALLER', AT, null);

    for (const [input] of runs.recordRunFinished.mock.calls) expect(input.firstErrorCode).toBeUndefined();
  });
});
