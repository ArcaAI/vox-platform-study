/**
 * `StudioToolbar` + `PublishDialog` — smoke + behavior coverage.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { StudioToolbar } from '../studio-toolbar';
import { PublishDialog } from '../publish-dialog';

describe('StudioToolbar', () => {
  it('disables Publish with a visible reason while the report is dirty/blocked', () => {
    render(
      <StudioToolbar
        viewMode="canvas"
        onViewModeChange={vi.fn()}
        autosaveState="idle"
        canUndo={false}
      canRedo={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onValidate={vi.fn()}
        onPublish={vi.fn()}
        publishDisabledReason="Run Validate before publishing."
      />,
    );
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(screen.getByText('Run Validate before publishing.')).toBeTruthy();
  });

  it('enables Publish once the report is clean', () => {
    render(
      <StudioToolbar
        viewMode="canvas"
        onViewModeChange={vi.fn()}
        autosaveState="saved"
        canUndo={false}
      canRedo={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onValidate={vi.fn()}
        onPublish={vi.fn()}
        publishDisabledReason={null}
      />,
    );
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('switching to List view calls onViewModeChange', () => {
    const onViewModeChange = vi.fn();
    render(
      <StudioToolbar viewMode="canvas" onViewModeChange={onViewModeChange} autosaveState="idle" canUndo={false}
      canRedo={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onValidate={vi.fn()} onPublish={vi.fn()} publishDisabledReason={null} />,
    );
    screen.getByRole('radio', { name: 'List view' }).click();
    expect(onViewModeChange).toHaveBeenCalledWith('list');
  });

  it('0 axe violations', async () => {
    const { container } = render(
      <StudioToolbar viewMode="canvas" onViewModeChange={vi.fn()} autosaveState="conflict" canUndo={false}
      canRedo={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onValidate={vi.fn()} onPublish={vi.fn()} publishDisabledReason="Resolve every error before publishing." />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('PublishDialog', () => {
  it('confirms with activate=true by default', () => {
    const onConfirm = vi.fn();
    render(<PublishDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    screen.getByRole('button', { name: /^Publish$/ }).click();
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('0 axe violations while open', async () => {
    render(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    // Scoped to the dialog panel itself, not `baseElement` — Radix's portal-level focus-trap
    // guard spans (`[data-radix-focus-guard]`, siblings of the dialog root) are a deliberate,
    // real-browser-only focus-management technique that axe's static jsdom scan cannot evaluate
    // correctly (it sees a tabbable `aria-hidden` node and flags it, with no way to tell that a
    // real browser's focus-trap semantics make it correct); scoping to the dialog itself keeps
    // the scan meaningful.
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});

describe('StudioToolbar undo/redo (UX pass)', () => {
  it('exposes labelled undo/redo buttons, disabled until there is history', () => {
    const onUndo = vi.fn();
    render(
      <StudioToolbar
        viewMode="canvas"
        onViewModeChange={vi.fn()}
        autosaveState="idle"
        canUndo={false}
        canRedo={false}
        onUndo={onUndo}
        onRedo={vi.fn()}
        onValidate={vi.fn()}
        onPublish={vi.fn()}
        publishDisabledReason={null}
      />,
    );
    expect((screen.getByRole('button', { name: /^Undo/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Redo/ }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    render(
      <StudioToolbar
        viewMode="canvas"
        onViewModeChange={vi.fn()}
        autosaveState="idle"
        canUndo
        canRedo={false}
        onUndo={onUndo}
        onRedo={vi.fn()}
        onValidate={vi.fn()}
        onPublish={vi.fn()}
        publishDisabledReason={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('hides undo/redo on a read-only (published) definition', () => {
    render(
      <StudioToolbar
        viewMode="canvas"
        onViewModeChange={vi.fn()}
        autosaveState="idle"
        readOnly
        canUndo
        canRedo
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onValidate={vi.fn()}
        onPublish={vi.fn()}
        publishDisabledReason="This version is already published."
      />,
    );
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });
});
