/**
 * TASK-1050 W3b round 2 — the Test tab adopts the shared guardrail trace: a Guardrail panel
 * (`RunGuardrailSummary`) that appears once the run has guardrail activity, and a guardrail badge
 * (`NodeGuardrailBadge`) on the Step panel.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { foldRunEvents } from '@/shared/sandbox/api/run-fold';
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';
import { StepPanel } from '../step-panel';
import { TestGuardrailPanel } from '../test-guardrail-panel';

afterEach(cleanup);

const started: RunEvent = {
  seq: 1,
  runId: 'r',
  type: 'run.started',
  ts: '2026-10-07T09:14:00.000Z',
  data: { kind: 'workflow', slug: 'w', versionNumber: 1 },
};
const nodeStarted: RunEvent = {
  seq: 2,
  runId: 'r',
  type: 'node.started',
  ts: '2026-10-07T09:14:00.000Z',
  nodeId: 'n_note',
  data: { kind: 'core.agent', label: 'Note' },
};
const warn: RunEvent = {
  seq: 3,
  runId: 'r',
  type: 'guardrail.inbound',
  ts: '2026-10-07T09:14:01.000Z',
  nodeId: 'n_note',
  data: { action: 'WARN', detected: 1, checks: [{ checkId: 'unsafe_content_judge', verdict: 'flag', actionTaken: 'warn', category: 'violence' }] },
};
const paused: RunEvent = {
  seq: 4,
  runId: 'r',
  type: 'run.paused',
  ts: '2026-10-07T09:14:02.000Z',
  data: { reason: 'guardrail_hold', noticeId: 'n-1', nodeId: 'n_note' },
};

describe('TestGuardrailPanel', () => {
  it('renders nothing for a run without guardrail activity', () => {
    const { container } = render(<TestGuardrailPanel view={foldRunEvents([started, nodeStarted])} />);
    expect(container.textContent).toBe('');
  });

  it('renders the shared guardrail summary once the run screens or pauses', () => {
    render(<TestGuardrailPanel view={foldRunEvents([started, nodeStarted, warn, paused])} />);
    expect(screen.getByRole('region', { name: 'Guardrail' })).toBeDefined();
    expect(screen.getByText(/paused at note on a guardrail hold/i)).toBeDefined();
    expect(screen.getAllByText('Warned').length).toBeGreaterThan(0);
  });
});

describe('StepPanel guardrail badge', () => {
  it('badges a step paused on a guardrail hold', () => {
    const view = foldRunEvents([started, nodeStarted, warn, paused]);
    render(<StepPanel node={{ id: 'n_note', type: 'core.agent', label: 'Note' }} run={view.nodes.n_note} hidePhi={false} live />);
    expect(screen.getByText('Paused on guardrail')).toBeDefined();
  });
});
