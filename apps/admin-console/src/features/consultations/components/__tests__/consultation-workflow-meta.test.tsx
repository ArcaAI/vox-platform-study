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

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { GoverningRun } from '../../api/types';
import { ConsultationWorkflowMeta } from '../consultation-workflow-meta';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Default: gate closed. Tests that need the link call `stubGates(true)` themselves.
beforeEach(() => stubGates(false));

/** The effective feature-gate map the run link is gated on (TASK-1059 C-05). */
function stubGates(workflowHarness: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [{ key: 'console.workflowHarness.enabled', value: workflowHarness }] })),
  );
}

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

  it('names the workflow and links to the run while it is running', async () => {
    stubGates(true);
    renderWithProviders(<ConsultationWorkflowMeta run={run({ status: 'RUNNING' })} />);

    expect(screen.getByText('cardiology-intake')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect((await screen.findByRole('link', { name: /View run/ })).getAttribute('href')).toBe('/workflow-runs/wr-1');
  });

  // TASK-1059 C-05: /workflow-runs/* is a 404 while the Workflow & Harness domain is off.
  it('shows the run id and status as plain text, with no link, while the harness gate is off', async () => {
    stubGates(false);
    renderWithProviders(<ConsultationWorkflowMeta run={run({ status: 'RUNNING' })} />);

    expect(await screen.findByText('wr-1')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole('link')).toBeNull();
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

  it('explains a failed run in the admin’s language and keeps the raw reason verbatim', async () => {
    stubGates(true);
    renderWithProviders(
      <ConsultationWorkflowMeta run={run({ status: 'FAILED', failureReason: '/referral: not declared in the bound version v2' })} />,
    );

    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText("This consultation ran without its workflow. Reason: the context didn't match what the workflow accepts.")).toBeDefined();
    expect(screen.getByText('/referral: not declared in the bound version v2')).toBeDefined();
    expect((await screen.findByRole('link', { name: /View run/ })).getAttribute('href')).toBe('/workflow-runs/wr-1');
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
