/**
 * `ConfirmDialog` — the console-wide confirmation surface. These tests cover the
 * two additions the context-schema publish flow needs on top of the original
 * title/description/type-to-confirm shape: a rich `body` region, and an
 * `acknowledgement` checkbox that arms the confirm button.
 *
 * The acknowledgement rule is a UX contract, not a detail: a disabled primary
 * action must carry a VISIBLE reason (rule 11 §5), so the checkbox label IS the
 * reason and is always rendered beside the disabled button.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ConfirmDialog } from '../confirm-dialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('renders the body region beneath the description', () => {
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Publish version 4?"
        description="This adds one new kind, referral."
        body={<p>11 workflows follow the latest version and will accept it.</p>}
        confirmLabel="Publish"
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText('This adds one new kind, referral.')).toBeDefined();
    expect(screen.getByText('11 workflows follow the latest version and will accept it.')).toBeDefined();
  });

  it('disables confirm until the acknowledgement is ticked, with the label as the visible reason', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Publish version 4?"
        description="2 workflows will refuse it."
        confirmLabel="Publish"
        acknowledgement="I understand these 2 workflows will refuse new consultations until they are republished."
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Publish' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    // The reason is on screen, not hidden in a tooltip.
    const checkbox = screen.getByRole('checkbox', {
      name: 'I understand these 2 workflows will refuse new consultations until they are republished.',
    });

    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(checkbox);
    expect(screen.getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('resets the acknowledgement when the dialog closes', () => {
    const { rerender } = renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Publish version 4?"
        description="2 workflows will refuse it."
        confirmLabel="Publish"
        acknowledgement="I understand."
        onConfirm={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand.' }));
    expect(screen.getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(false);

    rerender(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="Publish version 4?"
        description="2 workflows will refuse it."
        confirmLabel="Publish"
        acknowledgement="I understand."
        onConfirm={() => {}}
      />,
    );
    rerender(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Publish version 4?"
        description="2 workflows will refuse it."
        confirmLabel="Publish"
        acknowledgement="I understand."
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(true);
  });

  it('has no axe violations with a body and an acknowledgement', async () => {
    renderWithProviders(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Publish version 4?"
        description="2 workflows will refuse it."
        body={
          <ul>
            <li>Cardiology intake — pinned v2</li>
          </ul>
        }
        confirmLabel="Publish"
        acknowledgement="I understand these 2 workflows will refuse new consultations until they are republished."
        onConfirm={() => {}}
      />,
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
