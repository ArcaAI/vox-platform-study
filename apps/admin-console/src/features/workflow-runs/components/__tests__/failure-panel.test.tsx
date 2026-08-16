/**
 * Task 9 fixtures: retry group, node timeout in an otherwise-successful run,
 * degraded node, and (trace-pruned is covered in run-trace-screen.test.tsx,
 * since it's a whole-screen state, not this panel's concern).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FailurePanel } from '../failure-panel';
import type { RunNodeRollup, WorkflowRun } from '../../api/types';

function baseRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wr-1',
    tenantId: 'tnt-1',
    workflowVersionId: 'wfv-1',
    workflowSlug: 'triage',
    workflowVersionNumber: 1,
    definitionName: 'Triage',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'api invoke',
    status: 'COMPLETED',
    isSandbox: false,
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:01:00.000Z',
    durationMs: 60_000,
    nodeCount: 1,
    failedNodeCount: 0,
    degradedNodeCount: 0,
    firstErrorCode: null,
    createdAt: '2026-08-16T10:01:00.000Z',
    ...overrides,
  };
}

function rollup(overrides: Partial<RunNodeRollup> = {}): RunNodeRollup {
  return {
    nodeType: 'interpreter.noop',
    order: 0,
    status: 'OK',
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:00:01.000Z',
    durationMs: 1000,
    errorCode: null,
    attemptSeqs: [0],
    attemptCount: 1,
    attemptGroupingIsDerived: true,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('FailurePanel', () => {
  it('renders nothing for a clean run', () => {
    const { container } = render(<FailurePanel run={baseRun()} nodes={[rollup()]} />);
    expect(container.textContent).toBe('');
  });

  it('surfaces a node timeout WITHOUT marking the run failed (pitfall 5)', () => {
    const run = baseRun({ status: 'COMPLETED', failedNodeCount: 0 });
    const nodes = [rollup({ nodeType: 'interpreter.slow', status: 'TIMEOUT' })];
    render(<FailurePanel run={run} nodes={nodes} />);
    expect(screen.getByText(/timed out/i)).toBeDefined();
    expect(screen.getByText(/does not by itself mean the run failed/i)).toBeDefined();
    expect(screen.queryByText(/^\d+ nodes? failed$/i)).toBeNull();
  });

  it('renders a degraded-node callout as a count/flag, never a status (pitfall 6)', () => {
    const run = baseRun({ degradedNodeCount: 2 });
    render(<FailurePanel run={run} nodes={[rollup()]} />);
    expect(screen.getByText(/2 nodes degraded/i)).toBeDefined();
    expect(screen.getByText(/marked nothing/i)).toBeDefined();
  });

  it('shows the failed-node callout and the first error code', () => {
    const run = baseRun({ failedNodeCount: 1, firstErrorCode: 'boom' });
    const nodes = [rollup({ status: 'ERROR', errorCode: 'boom' })];
    render(<FailurePanel run={run} nodes={nodes} />);
    expect(screen.getByText(/1 node failed/i)).toBeDefined();
    expect(screen.getByText('boom')).toBeDefined();
  });

  it('a derived retry group is visible via the node badge attempt count (Task 9 "retries")', () => {
    const run = baseRun({ failedNodeCount: 1 });
    const nodes = [rollup({ status: 'ERROR', attemptCount: 3, attemptSeqs: [0, 1, 2], attemptGroupingIsDerived: true })];
    render(<FailurePanel run={run} nodes={nodes} />);
    // FailurePanel itself only surfaces the run-level counts; the derived
    // attempt count is asserted at the badge/drawer level
    // (node-run-badge / run-trace-screen tests) — this test documents the
    // boundary rather than duplicating that assertion here.
    expect(screen.getByText(/1 node failed/i)).toBeDefined();
  });
});
