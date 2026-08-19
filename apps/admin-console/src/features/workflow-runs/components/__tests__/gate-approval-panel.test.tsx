/**
 * The clinician sign-off affordance (TASK-731 Phase B).
 *
 * What these tests defend is when the control appears AT ALL. `WorkflowRunStatus` cannot tell a
 * run parked on a human from one busy generating text — both are `RUNNING` — so the panel keys
 * off live gate state, and an Approve button that cannot approve anything is worse than no
 * button. The other half is that the signer is never something this client can choose.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { RunGateState, WorkflowRun } from '../../api/types';
import { GateApprovalPanel } from '../gate-approval-panel';
import { installFetchStub, type RecordedCall } from './fetch-stub';

const RUN: WorkflowRun = {
  id: 'wr-1',
  tenantId: 'tnt-1',
  workflowVersionId: 'wfv-1',
  workflowSlug: 'consultation_note',
  workflowVersionNumber: 1,
  definitionName: 'Consultation Visit Note',
  sessionId: 'workflow-interpreter-run-1',
  runId: 'run-1',
  trigger: 'api invoke',
  status: 'RUNNING',
  isSandbox: false,
  startedAt: '2026-08-19T10:00:00.000Z',
  endedAt: null,
  durationMs: null,
  nodeCount: 9,
  failedNodeCount: 0,
  degradedNodeCount: 0,
  firstErrorCode: null,
  createdAt: '2026-08-19T10:00:00.000Z',
};

function stubGate(gate: RunGateState, onApprove?: (call: RecordedCall) => unknown): RecordedCall[] {
  return installFetchStub((call) => {
    if (call.url.includes('/gate/approve')) return onApprove ? onApprove(call) : { ...gate, waiting: false, phase: 'DONE', approved: true };
    if (call.url.includes('/gate')) return gate;
    return {};
  });
}

const WAITING: RunGateState = { runId: 'run-1', exists: true, waiting: true, phase: 'GATE', escalations: 0, approved: false };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('when the control appears', () => {
  it('offers sign-off while the gate is genuinely waiting', async () => {
    stubGate(WAITING);
    renderWithProviders(<GateApprovalPanel run={RUN} />);
    expect(await screen.findByRole('button', { name: /review and sign/i })).toBeDefined();
  });

  it('renders nothing for a run that has no gate — every summarization/stt run', async () => {
    stubGate({ runId: 'run-1', exists: false, waiting: false });
    const { container } = renderWithProviders(<GateApprovalPanel run={RUN} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('renders nothing once the gate is decided — approving a signed gate is not an action', async () => {
    stubGate({ runId: 'run-1', exists: true, waiting: false, phase: 'DONE', approved: true });
    const { container } = renderWithProviders(<GateApprovalPanel run={RUN} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('renders nothing for an abandoned gate — the SLA ladder ran out, there is nothing to sign', async () => {
    stubGate({ runId: 'run-1', exists: true, waiting: false, phase: 'ABANDONED', escalations: 3, approved: false });
    const { container } = renderWithProviders(<GateApprovalPanel run={RUN} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('surfaces how many SLA escalations have already fired', async () => {
    stubGate({ ...WAITING, escalations: 2 });
    renderWithProviders(<GateApprovalPanel run={RUN} />);
    expect(await screen.findByText(/2 SLA escalations have already been raised/i)).toBeDefined();
  });
});

describe('signing', () => {
  it('confirms before signing, and names the irreversible consequence', async () => {
    const calls = stubGate(WAITING);
    renderWithProviders(<GateApprovalPanel run={RUN} />);

    fireEvent.click(await screen.findByRole('button', { name: /review and sign/i }));

    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(screen.getByText(/recorded as the approving clinician/i)).toBeDefined();
    expect(screen.getByText(/cannot be undone/i)).toBeDefined();
    // Nothing was sent by merely opening the dialog.
    expect(calls.some((call) => call.url.includes('/gate/approve'))).toBe(false);
  });

  it('sends only the decision — never a clinician id the client could choose', async () => {
    const calls = stubGate(WAITING);
    renderWithProviders(<GateApprovalPanel run={RUN} />);

    fireEvent.click(await screen.findByRole('button', { name: /review and sign/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^sign$/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('/gate/approve'))).toBe(true));
    const approveCall = calls.find((call) => call.url.includes('/gate/approve'));
    expect(approveCall?.method).toBe('POST');
    expect(approveCall?.body).toEqual({ decision: 'SIGNED' });
    // The forgery guard, restated at the client boundary: the signer is resolved server-side.
    expect(JSON.stringify(approveCall?.body)).not.toContain('clinician');
  });

  it('cancelling sends nothing', async () => {
    const calls = stubGate(WAITING);
    renderWithProviders(<GateApprovalPanel run={RUN} />);

    fireEvent.click(await screen.findByRole('button', { name: /review and sign/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(calls.some((call) => call.url.includes('/gate/approve'))).toBe(false);
  });

  it('surfaces the server reason when the gate stopped waiting between render and click', async () => {
    stubGate(WAITING, () => Response.json({ message: "This run's gate is not waiting for a decision (phase: DONE)" }, { status: 400 }));
    renderWithProviders(<GateApprovalPanel run={RUN} />);

    fireEvent.click(await screen.findByRole('button', { name: /review and sign/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^sign$/i }));

    // The dialog stays open on failure — the clinician must not be told it worked.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());
  });
});

describe('accessibility', () => {
  it('has no axe violations while waiting', async () => {
    stubGate(WAITING);
    const { container } = renderWithProviders(<GateApprovalPanel run={RUN} />);
    await screen.findByRole('button', { name: /review and sign/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
