/**
 * `WorkflowStudioEditor` — TASK-1036 wave C, lane C2a: the studio SHELL.
 *
 * Pins what the shell now owns: the §3.6 header (inline rename, slug, status, version count →
 * history sheet, Pins, Settings, Validate / Publish), the Composer · Test · Integration tabs (state
 * in the URL), and the canvas-first layout whose palette and inspector are `FloatingPane`s. The
 * stubs the other lanes fill (`test-tab`, `integration-tab`, the history sheet, the settings
 * dialog) are mounted here with their current props — those contracts are what this file locks.
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { WorkflowStudioEditor } from '../workflow-studio-editor';
import type { WorkflowDefinition, WorkflowNodeDescriptor, WorkflowValidationReport } from '../../api/types';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

vi.mock('@arcaai/ui/components/workflow-canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/ui/components/workflow-canvas')>();
  return {
    ...actual,
    WorkflowCanvas: (props: { emptyState?: ReactNode; nodes?: unknown[]; onSelect?: (id: string | null) => void }) => (
      <div data-testid="canvas-stub">
        <button type="button" onClick={() => props.onSelect?.('n1')}>
          select n1
        </button>
        {(props.nodes?.length ?? 0) === 0 ? props.emptyState : null}
      </div>
    ),
  };
});
vi.mock('../palette', () => ({ PaletteRail: () => <div data-testid="palette-stub" /> }));
vi.mock('../inspector', () => ({
  InspectorPanel: () => <div data-testid="inspector-stub" />,
}));
vi.mock('../test-tab', () => ({
  TestTab: (props: { definitionId: string }) => <div data-testid="test-tab" data-definition-id={props.definitionId} />,
  useNodeLastRuns: () => ({}),
}));
vi.mock('../integration-tab', () => ({ IntegrationTab: (props: { definitionId: string }) => <div data-testid="integration-tab" data-definition-id={props.definitionId} /> }));

const historyProps = vi.hoisted(() => ({ last: null as null | { slug: string; currentDefinitionId?: string; open: boolean } }));
vi.mock('../management/version-history-sheet', () => ({
  VersionHistorySheet: (props: { slug: string; currentDefinitionId?: string; open: boolean }) => {
    historyProps.last = props;
    return props.open ? <div role="dialog" aria-label="Version history stub" /> : null;
  },
}));
vi.mock('../settings/settings-dialog', () => ({
  SettingsDialog: (props: { open: boolean }) => (props.open ? <div role="dialog" aria-label="Settings stub" /> : null),
}));

const OK_REPORT: WorkflowValidationReport = { reportVersion: 1, ok: true, findings: [], ruleSetVersion: 1, registryChecksum: 'reg', evaluatedAt: '2026-09-13T00:00:00.000Z' };

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
        { id: 'n1', type: 'core.agent', config: { label: 'Summarize', agentRef: { slug: 'discharge-agent', versionNumber: 4 } }, position: { x: 10, y: 10 } },
        { id: 'n2', type: 'core.agent', config: { agentRef: { slug: 'extract-agent' } }, position: { x: 200, y: 10 } },
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

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/versions')) return Response.json([definition(), definition({ id: 'd-0', versionNumber: 2 }), definition({ id: 'd-x', versionNumber: 1 })]);
      if (url.includes('/prompt-bindings')) return Response.json([]);
      return Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    }),
  );
}

function renderEditor(overrides: Partial<WorkflowDefinition> = {}, searchParams = '') {
  installFetch();
  const onUrlUpdate = vi.fn();
  const view = renderWithProviders(<WorkflowStudioEditor definition={definition(overrides)} etag={'"1"'} registryNodes={[AGENT]} />, { searchParams, onUrlUpdate });
  return { ...view, onUrlUpdate };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  push.mockClear();
  historyProps.last = null;
});

describe('studio shell — header (§3.6)', () => {
  it('names the workflow as the h1, with slug, lifecycle badge and version', () => {
    renderEditor();
    expect(screen.getByRole('heading', { level: 1, name: 'Discharge Summary' })).toBeTruthy();
    expect(screen.getByText('discharge_summary')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getAllByText('v3').length).toBeGreaterThan(0);
  });

  it('renames inline and stages the rename for the one explicit Save', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Discharge Summary/ }));
    const input = screen.getByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('heading', { level: 1, name: 'Renamed' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the lineage version count once it loads and opens the history sheet for this slug', async () => {
    renderEditor();
    const button = await screen.findByRole('button', { name: /version history, 3 versions/i });
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Version history stub' })).toBeTruthy();
    expect(historyProps.last).toMatchObject({ slug: 'discharge_summary', currentDefinitionId: 'd-1', open: true });
  });

  it('opens Settings', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings stub' })).toBeTruthy();
  });

  it('lists the agent pins read off the graph', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /pins/i }));
    const rail = screen.getByRole('dialog');
    expect(within(rail).getByText('discharge-agent')).toBeTruthy();
    expect(within(rail).getByText('v4')).toBeTruthy();
    expect(within(rail).getByText('extract-agent')).toBeTruthy();
    expect(within(rail).getByText('Active at publish')).toBeTruthy();
  });

  it('withholds Publish, with the reason on screen, until the SERVER report is ok', () => {
    renderEditor();
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Run Validate before publishing.')).toBeTruthy();
  });

  it('enables Publish when the stored report is ok and the buffer is clean', () => {
    renderEditor({ validationReport: OK_REPORT, status: 'VALIDATED' });
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('drops Validate, Publish and rename on a published version', () => {
    renderEditor({ status: 'PUBLISHED', isActive: true });
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Validate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Discharge Summary/ })).toBeNull();
    expect(screen.getByRole('button', { name: /edit as new draft/i })).toBeTruthy();
  });
});

describe('studio shell — tabs (§3.6)', () => {
  it('opens on Composer with Test and Integration beside it, as an underline tab list', () => {
    renderEditor();
    const list = screen.getByRole('tablist');
    expect(list.getAttribute('data-variant')).toBe('line');
    expect(within(list).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Composer', 'Test', 'Integration']);
    expect(screen.getByRole('tab', { name: 'Composer' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('canvas-stub')).toBeTruthy();
    expect(screen.queryByTestId('test-tab')).toBeNull();
  });

  it('keeps the tab in the URL: selecting Test writes ?tab=test and mounts the Test tab for this definition', async () => {
    const { onUrlUpdate } = renderEditor();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Test' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Test' }));
    await waitFor(() => expect(screen.getByTestId('test-tab').getAttribute('data-definition-id')).toBe('d-1'));
    expect(onUrlUpdate).toHaveBeenCalled();
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.get('tab')).toBe('test');
  });

  it('honours ?tab=integration on load', () => {
    renderEditor({}, '?tab=integration');
    expect(screen.getByRole('tab', { name: 'Integration' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('integration-tab').getAttribute('data-definition-id')).toBe('d-1');
  });

  it('falls back to Composer for an unknown ?tab=', () => {
    renderEditor({}, '?tab=nonsense');
    expect(screen.getByRole('tab', { name: 'Composer' }).getAttribute('aria-selected')).toBe('true');
  });

  it('has no toolbar Test button any more — the Test tab is the one way in (R-C #13)', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: /^test$/i })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Test' })).toBeTruthy();
  });

  it('warns on the Test tab while the buffer has unsaved edits — a run executes the SAVED definition', () => {
    renderEditor({}, '?tab=test');
    expect(screen.queryByText(/a test run executes the saved definition/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Discharge Summary/ }));
    const input = screen.getByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(/a test run executes the saved definition/i)).toBeTruthy();
  });

  it('keeps the Composer mounted (hidden) while another tab is open, so the canvas keeps its view', () => {
    renderEditor({}, '?tab=test');
    expect(screen.getByTestId('canvas-stub')).toBeTruthy();
    expect(screen.getByTestId('canvas-stub').closest('[hidden]')).toBeTruthy();
  });
});

describe('studio shell — floating panes (OD-17)', () => {
  it('floats the palette over the canvas as a named, collapsible pane', () => {
    renderEditor();
    const palette = screen.getByRole('region', { name: 'Nodes' });
    expect(palette.getAttribute('data-slot')).toBe('floating-pane');
    expect(within(palette).getByTestId('palette-stub')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Nodes' }));
    // Kept mounted (hidden) so a half-typed palette search survives a collapse.
    expect(screen.getByTestId('palette-stub').closest('[hidden]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Nodes' })).toBeTruthy();
  });

  it('shows the inspector pane, snapped right, only once a node is selected, and it closes', () => {
    renderEditor();
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'select n1' }));
    const inspector = screen.getByRole('region', { name: 'Inspector' });
    expect(inspector.getAttribute('data-dock')).toBe('right');
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull();
  });

  it('has 0 axe violations in the Composer', async () => {
    const { container } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'select n1' }));
    await act(async () => {});
    expect(await axe(container)).toHaveNoViolations();
  });
});
