/** TASK-1057 — AI Operations cancel reads `workflowRun.cancel`: a real reason when required, else the default text. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { TrajectorySession } from '../../api/types';
import { TrajectoryTimeline } from '../trajectory-timeline';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], cancel: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  getJson: vi.fn(async () => ({ items: mocks.rows })),
}));
vi.mock('@/shared/streams', () => ({ useEventStream: () => ({ status: 'idle' }) }));
vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  useSteps: () => ({ data: { pages: [{ items: [] }] }, isPending: false, error: null, hasNextPage: false }),
  useCancelWorkflow: () => ({ mutate: mocks.cancel, isPending: false }),
}));

const session: TrajectorySession = {
  sessionId: 'wf-1',
  runId: 'run-1',
  sessionKind: 'HARNESS_DOC',
  consultationId: null,
  stepCount: 0,
  firstStepAt: '2026-07-01T00:00:00.000Z',
  lastStepAt: '2026-07-01T00:05:00.000Z',
};
const row = (mode: 'required' | 'not-required') => ({ actionId: 'workflowRun.cancel', kind: 'reason', mode, locked: false });

async function openDialog(expected: string) {
  renderWithProviders(<TrajectoryTimeline session={session} />);
  await waitFor(() => expect(document.body.textContent).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /Cancel run/ }));
  const dialog = await screen.findByRole('alertdialog');
  await within(dialog).findByText(expected);
  return dialog;
}

beforeEach(() => mocks.cancel.mockReset());
afterEach(cleanup);

describe('TrajectoryTimeline cancel — workflowRun.cancel policy', () => {
  it('required: Cancel run stays disabled until a reason is typed, then sends it', async () => {
    mocks.rows = [row('required')];
    const dialog = await openDialog('Required. Recorded in the audit log.');
    const confirm = within(dialog).getByRole('button', { name: 'Cancel run' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'stuck on gate' } });
    fireEvent.click(confirm);
    expect(mocks.cancel.mock.calls[0][0]).toEqual({ workflowId: 'wf-1', reason: 'stuck on gate' });
  });

  it('not required: cancels with the default text', async () => {
    mocks.rows = [row('not-required')];
    const dialog = await openDialog('Recorded in the audit log when given.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    expect(mocks.cancel.mock.calls[0][0]).toEqual({ workflowId: 'wf-1', reason: 'Cancelled from AI Operations' });
  });
});
