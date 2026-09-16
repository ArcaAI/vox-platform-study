/**
 * The one row that answers "which workflow governed this consultation, and did
 * it work?" — five states, from one field already on the consultation response.
 *
 * Two of those states are the reason the row exists: a run that FAILED (the
 * consultation ran without its workflow, and nothing else on this screen says
 * so) and a run that completed DEGRADED. Degraded is a FLAG on a COMPLETED run,
 * never a status value, so the chip is derived from `degraded` and the status
 * vocabulary stays the persisted four.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { GoverningRun } from '../../api/types';
import { ConsultationWorkflowMeta } from '../consultation-workflow-meta';

afterEach(cleanup);

function run(overrides: Partial<GoverningRun> = {}): GoverningRun {
  return {
    workflowDefinitionSlug: 'cardiology-intake',
    workflowRunId: 'wr-1',
    status: 'COMPLETED',
    degraded: false,
    decidedAt: '2026-09-17T10:00:00.000Z',
    failureReason: null,
    ...overrides,
  };
}

describe('ConsultationWorkflowMeta', () => {
  it('says so plainly when nothing governed the consultation', () => {
    renderWithProviders(<ConsultationWorkflowMeta run={null} />);
    expect(screen.getByText('Not governed by a workflow')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('treats an absent field exactly like null — an older gateway is not a failure', () => {
    renderWithProviders(<ConsultationWorkflowMeta run={undefined} />);
    expect(screen.getByText('Not governed by a workflow')).toBeDefined();
  });

  it('names the workflow and links to the run while it is running', () => {
    renderWithProviders(<ConsultationWorkflowMeta run={run({ status: 'RUNNING' })} />);

    expect(screen.getByText('cardiology-intake')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByRole('link', { name: /View run/ }).getAttribute('href')).toBe('/workflow-runs/wr-1');
  });

  it('reads a completed run as completed', () => {
    renderWithProviders(<ConsultationWorkflowMeta run={run()} />);
    expect(screen.getByText('Completed')).toBeDefined();
  });

  it('reads a COMPLETED run carrying the degraded FLAG as "Completed with warnings"', () => {
    renderWithProviders(<ConsultationWorkflowMeta run={run({ degraded: true })} />);

    expect(screen.getByText('Completed with warnings')).toBeDefined();
    // Never a new status value — the vocabulary stays the persisted four.
    expect(screen.queryByText('DEGRADED')).toBeNull();
  });

  it('explains a failed run in the admin’s language and keeps the raw reason verbatim', () => {
    renderWithProviders(
      <ConsultationWorkflowMeta run={run({ status: 'FAILED', failureReason: '/referral: not declared in the bound version v2' })} />,
    );

    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText("This consultation ran without its workflow. Reason: the context didn't match what the workflow accepts.")).toBeDefined();
    expect(screen.getByText('/referral: not declared in the bound version v2')).toBeDefined();
    expect(screen.getByRole('link', { name: /View run/ }).getAttribute('href')).toBe('/workflow-runs/wr-1');
  });

  it('omits the raw-reason line when the gateway sent none', () => {
    renderWithProviders(<ConsultationWorkflowMeta run={run({ status: 'FAILED', failureReason: null })} />);

    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText(/This consultation ran without its workflow/)).toBeDefined();
  });

  it('has no axe violations in any state', async () => {
    for (const value of [null, run({ status: 'RUNNING' }), run({ degraded: true }), run({ status: 'FAILED', failureReason: 'boom' })]) {
      const { container, unmount } = renderWithProviders(
        <dl>
          <ConsultationWorkflowMeta run={value} />
        </dl>,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
