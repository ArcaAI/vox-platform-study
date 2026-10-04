/**
 * `WorkflowStudioEditor` — TASK-1036 F2 final-UI glue: importing a file with settings is ONE undo
 * step; the Composer lays the latest Test run over the canvas (node state + lit links); the
 * Integration tab is told when the buffer has unsaved changes.
 */
import type { ReactNode } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkflowStudioEditor } from '../workflow-studio-editor';
import type { WorkflowDefinition, WorkflowNodeDescriptor } from '../../api/types';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

type CanvasProps = Record<string, unknown> & {
  nodes?: ReadonlyArray<Record<string, unknown>>;
  emptyState?: ReactNode;
  onEdgeSelect?: (edgeId: string | null) => void;
  onEdgeInsert?: (edgeId: string) => void;
};
const canvas = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('@arcaai/ui/components/workflow-canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/ui/components/workflow-canvas')>();
  return {
    ...actual,
    WorkflowCanvas: (props: CanvasProps) => {
      canvas.last = props;
      return <div data-testid="canvas-stub">{(props.nodes?.length ?? 0) === 0 ? props.emptyState : null}</div>;
    },
  };
});

/** The palette stub reports a plain add and a PRESET add (the Merge preset's shape: a `core.data` config). */
const MERGE_CONFIG = { label: 'Merge', mode: 'merge' };
vi.mock('../palette', () => ({
  PaletteRail: ({
    descriptors,
    onAddNode,
  }: {
    descriptors: WorkflowNodeDescriptor[];
    onAddNode: (d: WorkflowNodeDescriptor, options?: { config: Record<string, unknown>; preset: unknown }) => void;
  }) => (
    <>
      <button type="button" onClick={() => descriptors[0] && onAddNode(descriptors[0])}>
        palette add
      </button>
      <button type="button" onClick={() => descriptors[0] && onAddNode(descriptors[0], { config: MERGE_CONFIG, preset: { key: 'merge', type: descriptors[0].type, config: MERGE_CONFIG } })}>
        palette add merge
      </button>
    </>
  ),
}));

const inspector = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('../inspector', () => ({
  InspectorPanel: (props: Record<string, unknown>) => {
    inspector.last = props;
    return <div data-testid="inspector-stub" />;
  },
}));

const lastRuns = vi.hoisted(() => ({ value: {} as Record<string, unknown>, calledWith: [] as string[] }));
vi.mock('../integration-tab', () => ({
  IntegrationTab: (props: { definitionId: string; unsavedChanges?: boolean }) => (
    <div data-testid="integration-tab" data-unsaved={String(props.unsavedChanges === true)} />
  ),
}));
vi.mock('../test-tab', () => ({
  TestTab: () => <div data-testid="test-tab" />,
  useNodeLastRuns: (definitionId: string) => {
    lastRuns.calledWith.push(definitionId);
    return lastRuns.value;
  },
}));

vi.mock('../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/hooks')>();
  return { ...actual, useAgentOptions: () => ({ data: [], isLoading: false }) };
});

const SETTINGS = { connections: ['api', 'sse'], sources: ['consultation'] };

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'd-1',
    tenantId: 'tnt-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'core',
    versionNumber: 2,
    parentVersionId: null,
    status: 'DRAFT',
    graph: { version: 1, nodes: [], edges: [] },
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
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    version: 1,
    tags: [],
    ...overrides,
  };
}

function descriptor(type: string): WorkflowNodeDescriptor {
  return {
    type,
    implemented: true,
    activityName: type,
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
}


const DATA = descriptor('core.data');
const NEW_SETTINGS = { connections: ['socket'], sources: [] };

function wired() {
  return definition({
    graph: {
      version: 1,
      nodes: [
        { id: 'n1', type: 'core.data', config: {}, position: { x: 0, y: 0 } },
        { id: 'n2', type: 'core.data', config: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', from: 'n1', fromPort: 'next', to: 'n2', toPort: 'after' }],
      settings: SETTINGS,
    } as WorkflowDefinition['graph'],
  });
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
}

beforeEach(() => {
  lastRuns.value = {};
  lastRuns.calledWith = [];
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  canvas.last = null;
  inspector.last = null;
});

describe('WorkflowStudioEditor — import with settings (F2)', () => {
  it('is ONE undo step: a single Undo restores the graph and its settings', async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:test'), revokeObjectURL: () => undefined }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);

    const file = new File([JSON.stringify({ version: 1, nodes: [{ id: 'x1', type: 'core.data', config: {} }], edges: [], settings: NEW_SETTINGS })], 'graph.json', {
      type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Import graph JSON'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('1 node · 0 connections')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' }));
    await waitFor(() => expect(screen.getByText('2 nodes · 1 connection')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const exported = JSON.parse(await blobs.at(-1)!.text()) as { settings?: unknown; nodes: unknown[] };
    expect(exported.settings).toEqual(SETTINGS);
    expect(exported.nodes).toHaveLength(2);
  });
});

describe('WorkflowStudioEditor — the latest Test run over the Composer (F2)', () => {
  it('hands the canvas each step’s run state and which links carried data', () => {
    lastRuns.value = {
      n1: { inputs: {}, outputs: {}, durationMs: 12, status: 'SUCCEEDED' },
      n2: { inputs: {}, outputs: {}, durationMs: null, status: 'RUNNING' },
    };
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);

    const nodes = canvas.last?.nodes as Array<{ id: string; runState?: string; runDurationMs?: number }>;
    expect(nodes.find((node) => node.id === 'n1')).toMatchObject({ runState: 'ok', runDurationMs: 12 });
    expect(nodes.find((node) => node.id === 'n2')).toMatchObject({ runState: 'running' });
    const edges = canvas.last?.edges as Array<{ id: string; runState?: string }>;
    expect(edges.find((edge) => edge.id === 'e1')?.runState).toBe('active');
  });

  it('shows no run overlay before any test run', () => {
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);
    const nodes = canvas.last?.nodes as Array<{ runState?: string }>;
    expect(nodes.every((node) => node.runState === undefined)).toBe(true);
  });
});

describe('WorkflowStudioEditor — Integration tab and unsaved changes (F2)', () => {
  function openIntegration(): HTMLElement {
    const tab = screen.getByRole('tab', { name: 'Integration' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    return screen.getByTestId('integration-tab');
  }

  it('is told the saved version is showing once the buffer is dirty', () => {
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);
    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));
    expect(openIntegration().getAttribute('data-unsaved')).toBe('true');
  });

  it('is told nothing is pending while the buffer is clean', () => {
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);
    expect(openIntegration().getAttribute('data-unsaved')).toBe('false');
  });
});
