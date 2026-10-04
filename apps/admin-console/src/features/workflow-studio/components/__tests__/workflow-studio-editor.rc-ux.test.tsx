/**
 * `WorkflowStudioEditor` — TASK-1036 review R-C, the studio-level fixes.
 *
 *  #1/#2 The canvas is told how far the docked panes reach in (`viewportInsets`), so its zoom
 *        controls, minimap and fit stay clear of them; a collapsed pane gives the room back. The
 *        Composer canvas keeps wheel-zoom even on a published version (it fills its region).
 *  #3    Short viewports / 200–400 % zoom (WCAG 1.4.10): at `md`+ the studio keeps a minimum
 *        height (the shell region scrolls instead of squeezing the canvas to nothing); below `md`
 *        the studio flows at its natural height — one scroll container (the shell), no nested
 *        ones.
 *  #7    The toolbar's Hide PHI drives the store's switch, which the inspector reads.
 *  #13   Rare actions (New, Edit details, Clone, Template, Import) live in the ⋯ menu; the
 *        toolbar's duplicate Test button is gone; the inspector gets "Open full trace in Test".
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { WorkflowStudioEditor } from '../workflow-studio-editor';
import type { WorkflowDefinition, WorkflowNodeDescriptor } from '../../api/types';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const canvasProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('@arcaai/ui/components/workflow-canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/ui/components/workflow-canvas')>();
  return {
    ...actual,
    WorkflowCanvas: (props: Record<string, unknown> & { emptyState?: ReactNode; nodes?: unknown[]; onSelect?: (id: string | null) => void }) => {
      canvasProps.last = props;
      return (
        <div data-testid="canvas-stub">
          <button type="button" onClick={() => props.onSelect?.('n1')}>
            select n1
          </button>
        </div>
      );
    },
  };
});
vi.mock('../palette', () => ({ PaletteRail: () => <div data-testid="palette-stub" /> }));
const inspectorProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('../inspector', () => ({
  InspectorPanel: (props: Record<string, unknown>) => {
    inspectorProps.last = props;
    return <div data-testid="inspector-stub" />;
  },
}));
vi.mock('../test-tab', () => ({
  TestTab: (props: { definitionId: string }) => <div data-testid="test-tab" data-definition-id={props.definitionId} />,
  useNodeLastRuns: () => ({}),
}));
vi.mock('../integration-tab', () => ({ IntegrationTab: () => <div data-testid="integration-tab" /> }));
vi.mock('../management/version-history-sheet', () => ({ VersionHistorySheet: () => null }));
vi.mock('../settings/settings-dialog', () => ({ SettingsDialog: () => null }));

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'd-1',
    tenantId: 'tnt-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'core',
    versionNumber: 3,
    parentVersionId: null,
    status: 'DRAFT',
    graph: {
      version: 1,
      nodes: [
        { id: 'n1', type: 'core.agent', config: { label: 'Summarize' }, position: { x: 10, y: 10 } },
        { id: 'n2', type: 'core.agent', config: {}, position: { x: 200, y: 10 } },
      ],
      edges: [],
    },
    graphChecksum: 'chk',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: null,
    validationReport: null,
    needsReview: false,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    isActive: false,
    resourceStatus: 'ENABLED',
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    version: 1,
    tags: [],
    ...overrides,
  };
}

const AGENT: WorkflowNodeDescriptor = {
  type: 'core.agent',
  implemented: true,
  activityName: 'core.agent',
  classes: [],
  paletteKey: 'core',
  critical: false,
  externalWrite: false,
  defaultTimeoutSeconds: 30,
  defaultMaxAttempts: 1,
  entitlementKey: null,
  configSchema: null,
  deprecated: false,
  replacedBy: null,
  inputs: [],
  outputs: [],
};

function renderEditor(overrides: Partial<WorkflowDefinition> = {}, searchParams = '') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/versions')) return Response.json([definition()]);
      if (url.includes('/prompt-bindings')) return Response.json([]);
      return Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    }),
  );
  const onUrlUpdate = vi.fn();
  const view = renderWithProviders(<WorkflowStudioEditor definition={definition(overrides)} etag={'"1"'} registryNodes={[AGENT]} />, { searchParams, onUrlUpdate });
  return { ...view, onUrlUpdate };
}

function openMoreMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More workflow actions' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  return screen.getByRole('menu');
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  push.mockClear();
  canvasProps.last = null;
  inspectorProps.last = null;
});

describe('R-C #1/#2 — the canvas knows where the panes are', () => {
  it('passes the docked palette’s footprint as the canvas inset, and takes it back on collapse', async () => {
    renderEditor();
    await waitFor(() => expect(canvasProps.last?.viewportInsets).toEqual({ left: 272, right: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Nodes' }));
    await waitFor(() => expect(canvasProps.last?.viewportInsets).toEqual({ left: 0, right: 0 }));
  });

  it('adds the inspector’s footprint on the right while it is open', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'select n1' }));
    await waitFor(() => expect(canvasProps.last?.viewportInsets).toEqual({ left: 272, right: 372 }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    await waitFor(() => expect(canvasProps.last?.viewportInsets).toEqual({ left: 272, right: 0 }));
  });

  it('keeps wheel zoom on the Composer canvas, published or not', () => {
    renderEditor({ status: 'PUBLISHED', isActive: true });
    expect(canvasProps.last?.wheelZoom).toBe('scroll');
  });
});

describe('R-C #3 — short viewports and 200–400 % zoom (WCAG 1.4.10)', () => {
  it('holds a minimum studio height at md and up, and flows at natural height below it', () => {
    renderEditor();
    const studio = screen.getByRole('tablist').closest('[data-slot="tabs"]') as HTMLElement;
    expect(studio.className).toContain('md:min-h-[40rem]');
    expect(studio.className).toContain('max-md:flex-none');
  });

  it('gives the Composer no scroll container of its own below md (the shell scrolls once)', () => {
    renderEditor();
    const stage = screen.getByTestId('canvas-stub').closest('[data-slot="composer-stage"]') as HTMLElement;
    expect(stage).toBeTruthy();
    expect(stage.className).not.toMatch(/(^|\s)overflow-y-auto(\s|$)/);
    expect(stage.className).toContain('md:overflow-hidden');
  });
});

describe('R-C #13 — header and toolbar declutter', () => {
  it('moves New and Edit details into the ⋯ menu with the clone / template / import actions', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit details/i })).toBeNull();
    const menu = openMoreMenu();
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'New workflow',
      'Edit details',
      'Clone this workflow',
      'Start from a template',
      'Import a bundle…',
    ]);
  });

  it('“New workflow” navigates to the create screen', () => {
    renderEditor();
    fireEvent.click(within(openMoreMenu()).getByRole('menuitem', { name: 'New workflow' }));
    expect(push).toHaveBeenCalledWith('/workflow-studio/new');
  });

  it('carries no toolbar Test button — the Test tab is beside the Composer', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: /^test$/i })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Test' })).toBeTruthy();
  });

  it('hands the inspector a way to open the Test tab (“Open full trace in Test”)', async () => {
    const { onUrlUpdate } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'select n1' }));
    const onOpenTest = inspectorProps.last?.onOpenTest as (() => void) | undefined;
    expect(typeof onOpenTest).toBe('function');
    act(() => onOpenTest?.());
    await waitFor(() => expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.get('tab')).toBe('test'));
  });
});

describe('R-C #7 — the toolbar’s Hide PHI is the studio switch', () => {
  it('toggles pressed state', () => {
    renderEditor();
    const toggle = screen.getByRole('button', { name: /hide phi/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /hide phi/i }).getAttribute('aria-pressed')).toBe('true');
  });

  it('0 axe violations in the decluttered Composer', async () => {
    const { container } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'select n1' }));
    await act(async () => {});
    expect(await axe(container)).toHaveNoViolations();
  });
});
