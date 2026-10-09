/**
 * TASK-1057 (OD-8) — `useReasonGate`: a REQUIRED row asks for a real reason and passes the typed
 * text; otherwise the write runs at once with the hard-coded default text.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { useActionConfirmation } from '@/shared/action-confirmations/use-action-confirmation';
import { useReasonGate } from '../reason-gate';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  getJson: vi.fn(async () => ({ items: mocks.rows })),
}));

const run = vi.fn(async (_reason: string) => undefined);

function Harness() {
  const gate = useReasonGate('agentAssignment.remove', 'Removed from the Agents screen');
  const policy = useActionConfirmation('agentAssignment.remove');
  return (
    <>
      <output data-testid="mode">{policy.isLoading ? 'loading' : policy.mode}</output>
      <button type="button" onClick={() => gate.request({ title: 'Remove', description: 'd', confirmLabel: 'Remove assignment', run })}>
        open
      </button>
      {gate.dialog}
    </>
  );
}

const row = (mode: 'required' | 'not-required') => ({ actionId: 'agentAssignment.remove', kind: 'reason', mode, locked: false });

beforeEach(() => run.mockClear());
afterEach(cleanup);

describe('useReasonGate', () => {
  it('required: opens a dialog, arms on a typed reason and sends it', async () => {
    mocks.rows = [row('required')];
    renderWithProviders(<Harness />);
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('required'));
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await screen.findByRole('textbox');
    const confirm = screen.getByRole('button', { name: 'Remove assignment' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(run).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'superseded by dept row' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(run).toHaveBeenCalledWith('superseded by dept row'));
  });

  it('not required: runs immediately with the default text, no dialog', async () => {
    mocks.rows = [row('not-required')];
    renderWithProviders(<Harness />);
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('not-required'));
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => expect(run).toHaveBeenCalledWith('Removed from the Agents screen'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
