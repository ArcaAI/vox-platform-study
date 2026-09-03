/**
 * `PolicyFormSheet` was a hand-rolled `SheetContent`; it now composes
 * the console-wide `DetailDrawer` with its actions in the PINNED footer
 * (submit reaches the form through `form={formId}`). Covered here: open/close
 * wiring, the accessible name, that the loaded row still seeds the editor
 * without a remount, and the guard that stops a close from silently
 * discarding unsaved edits.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Policy } from '../../api/types';
import { PolicyFormSheet } from '../policy-form-sheet';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const POLICY: Policy = {
  id: 'p-1',
  name: 'tenant.manage',
  description: 'Full tenant lifecycle',
  scope: 'TENANT',
  rules: [{ action: 'create', subject: 'Tenant' }],
  resourceStatus: 'ENABLED',
  isProtected: false,
  createdAt: '2026-01-05T08:00:00.000Z',
  updatedAt: '2026-06-21T08:00:00.000Z',
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(POLICY)),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PolicyFormSheet', () => {
  it('is closed until `open`, and names the create drawer', async () => {
    stubFetch();
    const { rerender } = renderWithProviders(<PolicyFormSheet open={false} onOpenChange={() => {}} policyId={null} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<PolicyFormSheet open onOpenChange={() => {}} policyId={null} />);
    // Accessible name comes from the drawer title.
    const dialog = await screen.findByRole('dialog', { name: 'New policy' });
    // Actions live in the pinned footer, reaching the form by id.
    expect((within(dialog).getByRole('button', { name: 'Create policy' }) as HTMLButtonElement).getAttribute('form')).toBeTruthy();
  });

  it('closes straight away when nothing was edited', async () => {
    stubFetch();
    const onOpenChange = vi.fn();
    renderWithProviders(<PolicyFormSheet open onOpenChange={onOpenChange} policyId={null} />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('never discards unsaved edits silently — closing asks first', async () => {
    stubFetch();
    const onOpenChange = vi.fn();
    renderWithProviders(<PolicyFormSheet open onOpenChange={onOpenChange} policyId={null} />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'consultation.read' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Discard unsaved changes?')).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('seeds the editor from the loaded row in the SAME drawer node (no remount)', async () => {
    stubFetch();
    renderWithProviders(<PolicyFormSheet open onOpenChange={() => {}} policyId="p-1" />);

    // The drawer node captured while the row is still loading must be the one
    // the loaded form renders into — the retired Sheet did the same.
    const dialog = await screen.findByRole('dialog', { name: 'Edit policy' });
    expect(await within(dialog).findByDisplayValue('tenant.manage')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDefined();
  });
});
