/**
 * SandboxNodeTrace tests (TASK-893 Contract C). Covers the null-guard prompts, the forward-
 * compatible exact-`nodeId`-match path (never hit by a real gateway response today — see the
 * component's own doc comment and `../../api/hooks.ts`'s `useSandboxNodeStates` doc comment for
 * why), and the honest fallback to the whole run's per-node list this component takes instead —
 * including the run-outcome-summary behaviour migrated from the retired
 * `features/workbench/components/__tests__/node-run-inspector-outcome.test.tsx` (R2): a DEGRADED
 * node has no per-node representation, so the run-level counts must render even though the
 * fallback list cannot show them per-row, and an absent count must render nothing rather than a
 * fabricated "0".
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { SandboxNodeTrace } from '../sandbox-node-trace';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubTrace(run: Record<string, unknown>, nodes: Record<string, unknown>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        run: { id: 'run-1', status: 'COMPLETED', isSandbox: true, ...run },
        nodes,
        stepCount: nodes.length,
        truncated: false,
        tracePruned: false,
      }),
    ),
  );
}

const DEGRADED_NODES = [
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
];

describe('SandboxNodeTrace', () => {
  it('prompts to start a run when runId is null', () => {
    renderWithProviders(<SandboxNodeTrace runId={null} nodeId={null} />);
    expect(screen.getByText(/start a sandbox run/i)).toBeDefined();
  });

  it('prompts to select a node when a run exists but no node is selected', () => {
    renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId={null} />);
    expect(screen.getByText(/select a node on the canvas/i)).toBeDefined();
  });

  describe('no wire nodeId yet — the honest fallback (current gateway behaviour)', () => {
    it('names the fallback explicitly rather than silently pretending to filter', async () => {
      stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' }, DEGRADED_NODES);
      renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId="canvas-node-7" />);

      await waitFor(() => expect(screen.getByText(/can't attribute trace rows to the selected node yet/i)).toBeTruthy());
    });

    it('reports the degraded node count, which has no per-node representation', async () => {
      stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' }, DEGRADED_NODES);
      renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId="canvas-node-7" />);

      await waitFor(() => expect(screen.getByText(/2 degraded/i)).toBeTruthy());
      expect(screen.getByText(/1 failed/i)).toBeTruthy();
      expect(screen.getByText('TEXT_TIMEOUT')).toBeTruthy();
    });

    it('still lists every per-node outcome, including SKIPPED', async () => {
      stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' }, DEGRADED_NODES);
      renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId="canvas-node-7" />);

      await waitFor(() => expect(screen.getByText('Skipped')).toBeTruthy());
      expect(screen.getByText('Error')).toBeTruthy();
    });

    it('states a clean run explicitly rather than rendering nothing', async () => {
      stubTrace({ nodeCount: 2, failedNodeCount: 0, degradedNodeCount: 0, firstErrorCode: null }, DEGRADED_NODES);
      renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId="canvas-node-7" />);

      await waitFor(() => expect(screen.getByText(/no failed or degraded nodes/i)).toBeTruthy());
    });

    it('omits the summary when the counts are absent rather than printing "0 degraded" from a missing field', async () => {
      stubTrace({}, DEGRADED_NODES);
      renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId="canvas-node-7" />);

      await waitFor(() => expect(screen.getByText('Skipped')).toBeTruthy());
      expect(screen.queryByText(/degraded/i)).toBeNull();
    });

    it('0 axe violations', async () => {
      stubTrace({ nodeCount: 4, failedNodeCount: 1, degradedNodeCount: 2, firstErrorCode: 'TEXT_TIMEOUT' }, DEGRADED_NODES);
      const { container } = renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId="canvas-node-7" />);

      await waitFor(() => expect(screen.getByText(/2 degraded/i)).toBeTruthy());
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe('a matching wire nodeId (forward-compatible — not produced by any gateway today)', () => {
    const MATCHED_NODES = [
      {
        nodeType: 'summarize',
        order: 1,
        status: 'OK',
        startedAt: '2026-08-23T10:00:00.000Z',
        endedAt: '2026-08-23T10:00:01.000Z',
        durationMs: 1000,
        errorCode: null,
        attemptSeqs: [1],
        attemptCount: 1,
        attemptGroupingIsDerived: true,
        nodeId: 'canvas-node-7',
      },
    ];

    it('renders that node’s own detail instead of the whole-run fallback', async () => {
      stubTrace({ nodeCount: 1, failedNodeCount: 0, degradedNodeCount: 0 }, MATCHED_NODES);
      renderWithProviders(<SandboxNodeTrace runId="run-1" nodeId="canvas-node-7" />);

      await waitFor(() => expect(screen.getByText('1,000 ms')).toBeTruthy());
      expect(screen.queryByText(/can't attribute trace rows/i)).toBeNull();
      expect(screen.getByText(/payload not available/i)).toBeTruthy();
    });
  });
});
