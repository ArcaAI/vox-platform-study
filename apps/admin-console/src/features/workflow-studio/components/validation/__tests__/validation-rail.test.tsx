/**
 * `ValidationRail` (TASK-719 Task 14). Publish-gate rule (`publishBlockedReason`) reads
 * `report.ok` only, per `validation-report.contract.md`.
 */
import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { ValidationRail, publishBlockedReason } from '../validation-rail';
import type { WorkflowFinding, WorkflowValidationReport } from '../../../api/types';
import type { GraphStoreNode } from '../../../store/types';

function report(findings: WorkflowFinding[], ok = findings.every((f) => f.severity !== 'ERROR')): WorkflowValidationReport {
  return { reportVersion: 1, ok, findings, ruleSetVersion: 1, registryChecksum: 'abc', evaluatedAt: '2026-08-16T00:00:00.000Z' };
}

const NODES: GraphStoreNode[] = [{ id: 'n1', type: 'noop', position: { x: 0, y: 0 }, safetyClasses: [], config: {} }];

describe('publishBlockedReason', () => {
  it('blocks with a reason when there is no report yet', () => {
    expect(publishBlockedReason(null)).toMatch(/validate/i);
  });
  it('blocks when the report is not ok', () => {
    expect(publishBlockedReason(report([{ ruleId: 'WF-S-001', ruleClass: 'structural', severity: 'ERROR', nodeId: null, message: 'cycle' }]))).toMatch(/error/i);
  });
  it('does not block a clean report', () => {
    expect(publishBlockedReason(report([]))).toBeNull();
  });
  it('WARNING-only findings never block (the sole predicate is report.ok, never re-derived)', () => {
    expect(publishBlockedReason(report([{ ruleId: 'WF-I-006', ruleClass: 'invariant', severity: 'WARNING', nodeId: 'n1', message: 'slow' }], true))).toBeNull();
  });
});

describe('ValidationRail', () => {
  it('shows "not yet validated" before any report exists', () => {
    render(<ValidationRail report={null} nodes={NODES} onActivate={vi.fn()} />);
    // Two matches by design: the visible EmptyTitle and the sr-only aria-live summary.
    expect(screen.getAllByText(/not yet validated/i).length).toBeGreaterThan(0);
  });

  it('shows "no problems found" for a clean report', () => {
    render(<ValidationRail report={report([])} nodes={NODES} onActivate={vi.fn()} />);
    expect(screen.getAllByText(/no problems found/i).length).toBeGreaterThan(0);
  });

  it('groups a graph-level finding (nodeId null) under a Graph bucket, distinct from per-node groups', () => {
    const findings: WorkflowFinding[] = [
      { ruleId: 'WF-S-001', ruleClass: 'structural', severity: 'ERROR', nodeId: null, message: 'cycle detected' },
      { ruleId: 'WF-C-001', ruleClass: 'schema', severity: 'ERROR', nodeId: 'n1', message: 'bad config' },
    ];
    render(<ValidationRail report={report(findings)} nodes={NODES} onActivate={vi.fn()} />);
    expect(screen.getByText('Graph')).toBeTruthy();
    expect(screen.getByText('cycle detected')).toBeTruthy();
    expect(screen.getByText('bad config')).toBeTruthy();
  });

  it('activating a problem row calls onActivate with that finding', () => {
    const onActivate = vi.fn();
    const finding: WorkflowFinding = { ruleId: 'WF-C-001', ruleClass: 'schema', severity: 'ERROR', nodeId: 'n1', message: 'bad config' };
    render(<ValidationRail report={report([finding])} nodes={NODES} onActivate={onActivate} />);
    screen.getByRole('button', { name: /bad config/i }).click();
    expect(onActivate).toHaveBeenCalledWith(finding);
  });

  it('0 axe violations with findings present', async () => {
    const findings: WorkflowFinding[] = [
      { ruleId: 'WF-S-001', ruleClass: 'structural', severity: 'ERROR', nodeId: null, message: 'cycle detected' },
      { ruleId: 'WF-I-006', ruleClass: 'invariant', severity: 'WARNING', nodeId: 'n1', message: 'slow node' },
    ];
    const { container } = render(<ValidationRail report={report(findings, false)} nodes={NODES} onActivate={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
