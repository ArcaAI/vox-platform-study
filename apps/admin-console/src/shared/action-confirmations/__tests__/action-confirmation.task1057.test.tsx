/**
 * TASK-1057 — the console half of the action-confirmation policy: catalogue-default fallback,
 * `when-risky`, min length, and the ConfirmDialog wiring (reason field + typed-name switch).
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { policyFrom } from '../use-action-confirmation';

vi.mock('@/shared/api', () => ({
  getJson: vi.fn(async () => ({
    items: [
      { actionId: 'promptTemplate.update', kind: 'reason', mode: 'required', locked: false, maxLength: 500 },
      { actionId: 'tenant.delete', kind: 'typeToConfirm', mode: 'not-required', locked: false },
    ],
  })),
}));

afterEach(cleanup);

describe('policyFrom', () => {
  it('falls back to the catalogue default before the policy loads', () => {
    expect(policyFrom('agent.promoteToSystem', undefined).isRequired()).toBe(true);
    expect(policyFrom('promptTemplate.update', undefined).isRequired()).toBe(false);
  });

  it('evaluates when-risky and minLength', () => {
    const unload = policyFrom('modelResidency.unload', undefined);
    expect(unload.isRequired(false)).toBe(false);
    expect(unload.isRequired(true)).toBe(true);
    const restore = policyFrom('tenantCheckpoint.restore', undefined);
    expect(restore.isSatisfied('short')).toBe(false);
    expect(restore.isSatisfied('long enough reason')).toBe(true);
  });

  it('an off row is always satisfied', () => {
    const row = { actionId: 'agent.promoteToSystem', kind: 'reason' as const, mode: 'not-required' as const, locked: false };
    expect(policyFrom('agent.promoteToSystem', row).isSatisfied('')).toBe(true);
  });
});

describe('ConfirmDialog with policy', () => {
  it('arms only once a required reason is typed, and passes it to onConfirm', async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ConfirmDialog open onOpenChange={() => {}} title="Save version?" description="d" confirmLabel="Save" onConfirm={onConfirm} reasonActionId="promptTemplate.update" />,
    );
    const button = await screen.findByRole('button', { name: 'Save' });
    await screen.findByText('Required. Recorded in the audit log.');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  tighten wording ' } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'tighten wording' });
  });

  it('drops the typed-name prompt when its row is switched off', async () => {
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete tenant?"
        description="d"
        confirmLabel="Delete"
        onConfirm={() => {}}
        destructive
        typeToConfirm="acme"
        typeToConfirmActionId="tenant.delete"
      />,
    );
    const button = await screen.findByRole('button', { name: 'Delete' });
    await vi.waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/to confirm/)).toBeNull();
  });
});
