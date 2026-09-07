/**
 * `StudioToolbar` + `PublishDialog` — smoke + behavior coverage.
 *
 * TASK-893 OD-7: the toolbar's view-mode toggle and autosave indicator are gone. What is pinned
 * here is the explicit save model that replaced them (Save / Discard / a save-state badge), the
 * two rail openers, and the "Node actions" menu that is the ONLY non-drag path for connecting
 * nodes and moving them into a loop now that the List view is deleted (WCAG 2.5.7).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { StudioToolbar, type StudioNodeCommands, type StudioToolbarProps } from '../studio-toolbar';
import { PublishDialog } from '../publish-dialog';

function toolbarProps(overrides: Partial<StudioToolbarProps> = {}): StudioToolbarProps {
  return {
    saveState: 'clean',
    canSave: false,
    canDiscard: false,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onValidate: vi.fn(),
    onPublish: vi.fn(),
    publishDisabledReason: null,
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    problemCount: 0,
    onOpenProblems: vi.fn(),
    onOpenRun: vi.fn(),
    ...overrides,
  };
}

function nodeCommands(overrides: Partial<StudioNodeCommands> = {}): StudioNodeCommands {
  return {
    nodeLabel: 'Extract entities',
    connectTargets: [{ id: 'n2', label: '2. Summarize' }],
    onConnectTo: vi.fn(),
    loopTargets: [],
    currentParentId: null,
    onMoveToLoop: vi.fn(),
    onWrapInLoop: vi.fn(),
    onUnwrapLoop: null,
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe('StudioToolbar', () => {
  it('disables Publish with a visible reason while the report is dirty/blocked', () => {
    render(<StudioToolbar {...toolbarProps({ publishDisabledReason: 'Run Validate before publishing.' })} />);
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(screen.getByText('Run Validate before publishing.')).toBeTruthy();
  });

  it('enables Publish once the report is clean', () => {
    render(<StudioToolbar {...toolbarProps({ saveState: 'saved' })} />);
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no view-mode toggle — there is one canvas and no list (OD-1)', () => {
    render(<StudioToolbar {...toolbarProps()} />);
    expect(screen.queryByRole('radio', { name: /list view/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /canvas view/i })).toBeNull();
  });

  it('0 axe violations', async () => {
    const { container } = render(
      <StudioToolbar {...toolbarProps({ saveState: 'conflict', canSave: true, canDiscard: true, problemCount: 3, publishDisabledReason: 'Resolve every error before publishing.', nodeCommands: nodeCommands() })} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('StudioToolbar — explicit save model (TASK-893 OD-7)', () => {
  it('keeps Save disabled with nothing to write, and calls onSave once there is', () => {
    const onSave = vi.fn();
    render(<StudioToolbar {...toolbarProps({ onSave })} />);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    render(<StudioToolbar {...toolbarProps({ canSave: true, saveState: 'dirty', onSave })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('names the save state in text, never colour alone', () => {
    render(<StudioToolbar {...toolbarProps({ saveState: 'dirty', canSave: true })} />);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    cleanup();
    render(<StudioToolbar {...toolbarProps({ saveState: 'conflict' })} />);
    expect(screen.getByText('Conflict — not saved')).toBeTruthy();
  });

  it('confirms before discarding — the one action here that destroys work (rule 11 §5)', async () => {
    const onDiscard = vi.fn();
    render(<StudioToolbar {...toolbarProps({ canDiscard: true, saveState: 'dirty', onDiscard })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /discard changes/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('StudioToolbar — rail openers', () => {
  it('shows the problem count and opens the Problems tab', () => {
    const onOpenProblems = vi.fn();
    render(<StudioToolbar {...toolbarProps({ problemCount: 4, onOpenProblems })} />);
    const problems = screen.getByRole('button', { name: /problems/i });
    expect(problems.textContent).toContain('4');
    fireEvent.click(problems);
    expect(onOpenProblems).toHaveBeenCalledTimes(1);
  });

  it('opens the Run tab in the studio instead of linking out to the Workbench (OD-3)', () => {
    const onOpenRun = vi.fn();
    render(<StudioToolbar {...toolbarProps({ onOpenRun })} />);
    expect(screen.queryByRole('link', { name: /workbench/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
  });

  it('offers Test on a read-only (published) version too — running a graph is a read', () => {
    render(<StudioToolbar {...toolbarProps({ readOnly: true, publishDisabledReason: 'This version is already published.' })} />);
    expect(screen.getByRole('button', { name: /^test$/i })).toBeTruthy();
  });
});

/**
 * The List view was the documented pointer-free path for connecting, reordering and deleting
 * nodes. It is deleted, so this menu carries that contract — a disabled trigger with nothing
 * selected, and the selected node named on it so the admin knows what they are about to act on.
 */
describe('StudioToolbar — node commands are the keyboard path (WCAG 2.5.7)', () => {
  it('disables the menu with no node selected rather than hiding it', () => {
    render(<StudioToolbar {...toolbarProps({ nodeCommands: null })} />);
    const trigger = screen.getByRole('button', { name: /node actions/i }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('title')).toMatch(/select a node/i);
  });

  it('enables it and names the selected node once there is one', () => {
    render(<StudioToolbar {...toolbarProps({ nodeCommands: nodeCommands() })} />);
    const trigger = screen.getByRole('button', { name: /node actions/i }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('title')).toMatch(/extract entities/i);
  });

  it('is not offered on a read-only version, where no mutation is possible at all', () => {
    render(<StudioToolbar {...toolbarProps({ readOnly: true, nodeCommands: nodeCommands(), publishDisabledReason: 'This version is already published.' })} />);
    expect(screen.queryByRole('button', { name: /node actions/i })).toBeNull();
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
    render(<StudioToolbar {...toolbarProps({ onUndo })} />);
    expect((screen.getByRole('button', { name: /^Undo/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Redo/ }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    render(<StudioToolbar {...toolbarProps({ canUndo: true, onUndo })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('hides undo/redo, Save and Discard on a read-only (published) definition', () => {
    render(
      <StudioToolbar
        {...toolbarProps({ readOnly: true, canUndo: true, canRedo: true, canSave: true, canDiscard: true, publishDisabledReason: 'This version is already published.' })}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    // The badge says why, rather than leaving a toolbar that is simply missing its controls.
    expect(screen.getByText('Read-only')).toBeTruthy();
  });
});
