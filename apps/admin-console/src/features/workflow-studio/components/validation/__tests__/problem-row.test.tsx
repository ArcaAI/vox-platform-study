/**
 * `ProblemRow` — TASK-890 §3.5 findings are rendered BY CODE (`GUARDRAIL_OPTED_OUT`,
 * `PROMPT_VARIABLE_UNDECLARED`, `MODEL_NOT_READY`, `AGENT_REF_MISSING`, …), a shared vocabulary
 * with `AgentFindingCode`, alongside the existing `ruleId`. A finding minted before this ticket
 * carries no `code` — the row degrades to `ruleId` alone rather than rendering an empty badge.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemRow } from '../problem-row';
import type { WorkflowFinding } from '../../../api/types';

afterEach(() => cleanup());

function finding(overrides: Partial<WorkflowFinding> = {}): WorkflowFinding {
  return { ruleId: 'WF-C-004', ruleClass: 'schema', severity: 'ERROR', nodeId: 'n1', message: 'the referenced agent does not exist', ...overrides };
}

describe('ProblemRow', () => {
  it('renders the finding code alongside ruleId when the server supplies one', () => {
    render(
      <ul>
        <ProblemRow finding={finding({ code: 'AGENT_REF_MISSING' })} onActivate={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText('AGENT_REF_MISSING')).toBeTruthy();
    expect(screen.getByText('WF-C-004')).toBeTruthy();
  });

  it('renders a WARNING code (e.g. GUARDRAIL_OPTED_OUT) with the secondary badge, never destructive', () => {
    render(
      <ul>
        <ProblemRow finding={finding({ severity: 'WARNING', code: 'GUARDRAIL_OPTED_OUT', message: 'platform guardrail is disabled on this node' })} onActivate={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText('GUARDRAIL_OPTED_OUT')).toBeTruthy();
    const severityBadge = screen.getByText('WARNING');
    expect(severityBadge.getAttribute('data-variant')).toBe('secondary');
  });

  it('degrades to ruleId alone when the finding carries no code (a pre-TASK-890 finding)', () => {
    render(
      <ul>
        <ProblemRow finding={finding()} onActivate={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText('WF-C-004')).toBeTruthy();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  it('activating the row calls onActivate with the finding, to focus its node', () => {
    const onActivate = vi.fn();
    const target = finding({ code: 'AGENT_REF_MISSING' });
    render(
      <ul>
        <ProblemRow finding={target} onActivate={onActivate} />
      </ul>,
    );
    screen.getByRole('button').click();
    expect(onActivate).toHaveBeenCalledWith(target);
  });

  it('0 axe violations', async () => {
    const { container } = render(
      <ul>
        <ProblemRow finding={finding({ code: 'AGENT_REF_MISSING' })} onActivate={vi.fn()} />
      </ul>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
