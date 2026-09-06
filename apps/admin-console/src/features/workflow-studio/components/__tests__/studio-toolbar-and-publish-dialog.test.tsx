/**
 * `StudioToolbar` + `PublishDialog` — smoke + behavior coverage.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
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

function stubWorkflowSchemaFetch(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        slug: 'discharge-summary',
        versionNumber: 3,
        triggerKinds: ['api'],
        protocols: ['http', 'http-sse'],
        modes: ['async', 'blocking', 'stream'],
        ...overrides,
      }),
    ),
  );
}

describe('PublishDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('confirms with activate=true by default', () => {
    const onConfirm = vi.fn();
    renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    screen.getByRole('button', { name: /^Publish$/ }).click();
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('0 axe violations while open', async () => {
    renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    // Scoped to the dialog panel itself, not `baseElement` — Radix's portal-level focus-trap
    // guard spans (`[data-radix-focus-guard]`, siblings of the dialog root) are a deliberate,
    // real-browser-only focus-management technique that axe's static jsdom scan cannot evaluate
    // correctly (it sees a tabbable `aria-hidden` node and flags it, with no way to tell that a
    // real browser's focus-trap semantics make it correct); scoping to the dialog itself keeps
    // the scan meaningful.
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });

  describe('TASK-890 §3.10 — the endpoints panel, once published', () => {
    it('is not shown before publishing (the confirm step, unchanged)', () => {
      renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} slug="discharge-summary" />);
      expect(screen.queryByText(/POST \/workflows/)).toBeNull();
    });

    it('lists POST /workflows/{slug}/runs once published', async () => {
      stubWorkflowSchemaFetch();
      renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" />);
      expect(await screen.findByText('POST /workflows/discharge-summary/runs')).toBeTruthy();
    });

    it('lists the ?mode= set resolved from the schema, EXCLUDING socket (a delivery lane, not a query value)', async () => {
      stubWorkflowSchemaFetch({ modes: ['async', 'blocking', 'stream', 'socket'] });
      renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" />);
      expect(await screen.findByText('async')).toBeTruthy();
      expect(screen.getByText('blocking')).toBeTruthy();
      expect(screen.getByText('stream')).toBeTruthy();
      expect(screen.queryByText('socket')).toBeNull();
    });

    it('renders a copyable @arcaai/vox-node snippet naming the slug', async () => {
      stubWorkflowSchemaFetch();
      renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" />);
      const snippet = await screen.findByRole('group', { name: /vox-node/i });
      expect(snippet.textContent).toContain('@arcaai/vox-node');
      expect(snippet.textContent).toContain('discharge-summary');
    });

    it('links to /api-keys', async () => {
      stubWorkflowSchemaFetch();
      renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" />);
      const link = (await screen.findByRole('link', { name: /api keys/i })) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/api-keys');
    });

    it('0 axe violations in the published endpoints view', async () => {
      stubWorkflowSchemaFetch();
      renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" />);
      await screen.findByText('POST /workflows/discharge-summary/runs');
      expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
    });

    it('0 axe violations in the published endpoints view, dark theme', async () => {
      document.documentElement.classList.add('dark');
      stubWorkflowSchemaFetch();
      renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" />);
      await screen.findByText('POST /workflows/discharge-summary/runs');
      expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
      document.documentElement.classList.remove('dark');
    });
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
