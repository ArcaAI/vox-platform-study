/**
 * TASK-965 WS-3 — the three consequence-naming confirmations (§3.1 point 5, the Vercel/Auth0
 * pattern): every irreversible lifecycle action states what BECOMES true, what STOPS serving,
 * and which assignments follow, before it is armed.
 *
 * AG-4 is the defect these close: deprecating the active version sets `isActive=false` and leaves
 * the tenant-default assignment pointing at nothing, and the old confirm never mentioned it. The
 * assignment is per-SLUG, so it FOLLOWS an activation automatically and BREAKS on a deprecation —
 * two opposite consequences that only the dialog can explain.
 *
 * They compose the console's own `ConfirmDialog` rather than a second AlertDialog, so type-to-
 * confirm, the acknowledgement arming rule and Radix focus management stay in one place.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ActivateVersionDialog, DeprecateVersionDialog, DiscardDraftDialog } from '../lifecycle-dialogs';

afterEach(cleanup);

describe('ActivateVersionDialog', () => {
  it('names what becomes active, what stops serving and which assignments follow', () => {
    renderWithProviders(
      <ActivateVersionDialog
        open
        onOpenChange={() => {}}
        itemLabel="General Medicine Summarization"
        slug="general-medicine-summarization"
        versionNumber={2}
        currentActiveVersionNumber={3}
        assignment={{ tenantDefault: true, departmentCount: 2 }}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(screen.getByText(/v2 becomes the active version/i)).toBeDefined();
    expect(screen.getByText(/v3 stops serving/i)).toBeDefined();
    expect(screen.getByText(/2 department assignments/i)).toBeDefined();
    expect(screen.getByText(/tenant default/i)).toBeDefined();
  });

  it('states the verb and the version in the confirm label', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ActivateVersionDialog open onOpenChange={() => {}} itemLabel="Agent" slug="agent" versionNumber={2} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activate v2' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing is active yet instead of inventing a demotion', () => {
    renderWithProviders(
      <ActivateVersionDialog
        open
        onOpenChange={() => {}}
        itemLabel="Agent"
        slug="agent"
        versionNumber={1}
        currentActiveVersionNumber={null}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/no version is active/i)).toBeDefined();
  });
});

describe('DeprecateVersionDialog', () => {
  it('warns that the slug stops resolving when the ACTIVE version is deprecated (AG-4)', () => {
    renderWithProviders(
      <DeprecateVersionDialog
        open
        onOpenChange={() => {}}
        itemLabel="General Medicine Summarization"
        slug="general-medicine-summarization"
        versionNumber={3}
        isActive
        assignment={{ tenantDefault: true, departmentCount: 2 }}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/stop resolving/i)).toBeDefined();
    expect(screen.getByText(/tenant default/i)).toBeDefined();
  });

  it('requires typing the slug before deprecating the active version', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <DeprecateVersionDialog
        open
        onOpenChange={() => {}}
        itemLabel="Agent"
        slug="general-medicine-summarization"
        versionNumber={3}
        isActive
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Deprecate v3' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'general-medicine-summarization' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate v3' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not demand type-to-confirm for a version that serves nothing', () => {
    renderWithProviders(
      <DeprecateVersionDialog open onOpenChange={() => {}} itemLabel="Agent" slug="agent" versionNumber={1} onConfirm={() => {}} />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Deprecate v1' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('DiscardDraftDialog', () => {
  it('states that the draft body is lost and keeps the published history', () => {
    renderWithProviders(
      <DiscardDraftDialog open onOpenChange={() => {}} itemLabel="Discharge Summary" slug="discharge-summary" versionNumber={4} onConfirm={() => {}} />,
    );
    expect(screen.getByText(/cannot be recovered/i)).toBeDefined();
    expect(screen.getByText(/published versions are untouched/i)).toBeDefined();
  });

  it('is type-to-confirm gated on the slug', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <DiscardDraftDialog open onOpenChange={() => {}} itemLabel="Discharge Summary" slug="discharge-summary" versionNumber={4} onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('button', { name: 'Discard draft v4' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discharge-summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft v4' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('accessibility', () => {
  it('has no axe violations on the activate dialog', async () => {
    renderWithProviders(
      <ActivateVersionDialog
        open
        onOpenChange={() => {}}
        itemLabel="Agent"
        slug="agent"
        versionNumber={2}
        currentActiveVersionNumber={3}
        assignment={{ tenantDefault: true, departmentCount: 2, selectorCount: 1 }}
        onConfirm={() => {}}
      />,
    );
    expect(await axe(await screen.findByRole('alertdialog'))).toHaveNoViolations();
  });

  it('has no axe violations on the type-to-confirm deprecate dialog', async () => {
    renderWithProviders(
      <DeprecateVersionDialog open onOpenChange={() => {}} itemLabel="Agent" slug="agent" versionNumber={3} isActive onConfirm={() => {}} />,
    );
    expect(await axe(await screen.findByRole('alertdialog'))).toHaveNoViolations();
  });
});
