/**
 * (R2) — "show per-node outcome, not just a final verdict".
 *
 * The per-node list already existed. What it did NOT show is the
 * run-level DEGRADED/FAILED node counts, even though `GET admin/workflow-runs/:id/trace`
 * returns them: `RunTraceResponse.run` is the full `WorkflowRunResponse`, which carries
 * `nodeCount` / `failedNodeCount` / `degradedNodeCount` / `firstErrorCode`. The Workbench's
 * local wire type narrowed `run` to `{ id, status, isSandbox }` and dropped them on the floor.
 *
 * This matters because a DEGRADED node — one that produced a marked nothing — has NO per-node
 * representation at all: `AgentStepStatus` is `STARTED | OK | ERROR | SKIPPED | TIMEOUT`, and
 * `RunNodeRollupResponse`'s own docs state a degraded node and a critically-failed one both
 * persist as `ERROR`. The run-level count is therefore the ONLY place degradation is visible.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { NodeRunInspector } from '../node-run-inspector';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubTrace(run: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        run: { id: 'run-1', status: 'COMPLETED', isSandbox: true, ...run },
        nodes: [
          {
            nodeType: 'summarize',
            order: 1,
            status: 'ERROR',
            startedAt: '2026-08-23T10:00:00.000Z',
            endedAt: '2026-08-23T10:00:01.000Z',
            durationMs: 1000,
            errorCode: 'TEXT_TIMEOUT',
            attemptSeqs: [1],
            attemptCount: 1,
            attemptGroupingIsDerived: true,
          },
          {
            nodeType: 'guardrail',
            order: 2,
            status: 'SKIPPED',
            startedAt: '2026-08-23T10:00:01.000Z',
            endedAt: '2026-08-23T10:00:01.000Z',
            durationMs: 0,
            errorCode: null,
            attemptSeqs: [2],
            attemptCount: 1,
            attemptGroupingIsDerived: true,
          },
        ],
        stepCount: 2,
        truncated: false,
        tracePruned: false,
      }),
    ),
  );
}

describe('NodeRunInspector — run outcome summary (W1)', () => {
  it('reports the degraded node count, which has no per-node representation', async () => {
    stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' });
    renderWithProviders(<NodeRunInspector runId="run-1" />);

    await waitFor(() => expect(screen.getByText(/2 degraded/i)).toBeTruthy());
    expect(screen.getByText(/1 failed/i)).toBeTruthy();
  });

  it('names the first error code so a mis-authored graph says why it broke', async () => {
    stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' });
    renderWithProviders(<NodeRunInspector runId="run-1" />);

    await waitFor(() => expect(screen.getByText('TEXT_TIMEOUT')).toBeTruthy());
  });

  it('states a clean run explicitly rather than rendering nothing', async () => {
    stubTrace({ nodeCount: 2, failedNodeCount: 0, degradedNodeCount: 0, firstErrorCode: null });
    renderWithProviders(<NodeRunInspector runId="run-1" />);

    await waitFor(() => expect(screen.getByText(/no failed or degraded nodes/i)).toBeTruthy());
  });

  it('still lists every per-node outcome, including SKIPPED', async () => {
    stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' });
    renderWithProviders(<NodeRunInspector runId="run-1" />);

    await waitFor(() => expect(screen.getByText('Skipped')).toBeTruthy());
    expect(screen.getByText('Error')).toBeTruthy();
  });

  it('omits the summary when the counts are absent rather than printing "0 degraded" from a missing field', async () => {
    stubTrace({});
    renderWithProviders(<NodeRunInspector runId="run-1" />);

    await waitFor(() => expect(screen.getByText('Skipped')).toBeTruthy());
    expect(screen.queryByText(/degraded/i)).toBeNull();
  });

  it('0 axe violations', async () => {
    stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' });
    const { container } = renderWithProviders(<NodeRunInspector runId="run-1" />);

    await waitFor(() => expect(screen.getByText(/2 degraded/i)).toBeTruthy());
    expect(await axe(container)).toHaveNoViolations();
  });
});
