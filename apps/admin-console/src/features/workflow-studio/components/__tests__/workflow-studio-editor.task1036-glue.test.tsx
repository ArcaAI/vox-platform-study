/**
 * `WorkflowStudioEditor` — TASK-1036 wave C batch 2, lane C2c: the EDITOR GLUE between lane C2b's
 * composer and lane C2a's studio shell.
 *
 * Pins what the editor now owes the composer:
 *  - the Composer tab mounts `ComposerCanvas` (typed ports, auto-map, `+` on a link, "Add a step"),
 *    not the bare `WorkflowCanvas` with the editor's own connect / drop / delete code;
 *  - `graph.settings` is PERSISTED: hydrated from the definition, written by Save, carried by the
 *    graph export, and survives save → reload → export (it used to be dropped on the floor);
 *  - a palette PRESET (Merge) arrives with its config;
 *  - selecting a LINK opens the inspector (the edge inspector lives there);
 *  - the inspector is fed the Test tab's last run per node (`useNodeLastRuns`);
 *  - "Edit as new draft" uses `POST …/:id/draft` and, on 409 `OPEN_DRAFT_EXISTS`, opens the
 *    lineage's existing draft instead.
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(responder?: (call: RecordedCall) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const answered = responder?.(call);
      if (answered) return answered;
      if (call.method === 'GET') return Response.json([]);
      return Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    }),
  );
  return calls;
}

const patches = (calls: RecordedCall[]) => calls.filter((call) => call.method === 'PATCH').map((call) => call.body as { graph?: Record<string, unknown> });

/** Captures what the graph Export downloads. */
function captureDownloads(): Blob[] {
  const blobs: Blob[] = [];
  vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, {
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return 'blob:test';
    },
    revokeObjectURL: () => undefined,
  }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return blobs;
}

beforeEach(() => {
  lastRuns.value = {};
  lastRuns.calledWith = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  push.mockClear();
  canvas.last = null;
  inspector.last = null;
});

describe('WorkflowStudioEditor — mounts the composer canvas (TASK-1036 C2c)', () => {
  it('renders ComposerCanvas — "Add a step", `+` on a link, a link-select channel — in place of the bare canvas', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[DATA]} />);

    expect(screen.getByRole('button', { name: /add a step/i })).toBeTruthy();
    expect(typeof canvas.last?.onEdgeInsert).toBe('function');
    expect(typeof canvas.last?.onEdgeSelect).toBe('function');
    expect(canvas.last?.['aria-label']).toBe('Discharge Summary graph');
  });

  it('hides the composer’s add affordance on a read-only version', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition({ status: 'PUBLISHED' })} etag='"1"' registryNodes={[DATA]} />);

    expect(screen.queryByRole('button', { name: /add a step/i })).toBeNull();
    expect(canvas.last?.readOnly).toBe(true);
  });
});

describe('WorkflowStudioEditor — graph.settings is persisted (TASK-1036 §3.5)', () => {
  it('survives save → reload → export', async () => {
    const calls = installFetchMock();
    const withSettings = definition({ graph: { version: 1, nodes: [], edges: [], settings: SETTINGS } as WorkflowDefinition['graph'] });
    const first = renderWithProviders(<WorkflowStudioEditor definition={withSettings} etag='"1"' registryNodes={[DATA]} />);

    // Save: an edit makes the graph dirty, and the graph PATCH carries the settings it hydrated with.
    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    const savedGraph = patches(calls)[0]?.graph as unknown as WorkflowDefinition['graph'];
    expect((savedGraph as { settings?: unknown }).settings).toEqual(SETTINGS);
    first.unmount();

    // Reload: the editor hydrates from what was saved — and Export still carries the settings.
    const blobs = captureDownloads();
    renderWithProviders(<WorkflowStudioEditor definition={definition({ id: 'd-1', version: 2, graph: savedGraph })} etag='"2"' registryNodes={[DATA]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(blobs).toHaveLength(1);
    const exported = JSON.parse(await blobs[0]!.text()) as { settings?: unknown; nodes: unknown[] };
    expect(exported.settings).toEqual(SETTINGS);
    expect(exported.nodes).toHaveLength(1);
  });

  it('a graph with no settings saves without inventing one', async () => {
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[DATA]} />);

    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.graph).not.toHaveProperty('settings');
  });

  it('an imported graph’s settings ride the next Save', async () => {
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[DATA]} />);

    const file = new File([JSON.stringify({ version: 1, nodes: [{ id: 'x1', type: 'core.data', config: {} }], edges: [], settings: SETTINGS })], 'graph.json', {
      type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Import graph JSON'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('1 node · 0 connections')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect((patches(calls)[0]?.graph as { settings?: unknown }).settings).toEqual(SETTINGS);
  });
});

describe('WorkflowStudioEditor — palette presets (TASK-1036 §8.4 item 3)', () => {
  it('a preset add (Merge) arrives with the preset’s config', async () => {
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[DATA]} />);

    fireEvent.click(screen.getByRole('button', { name: 'palette add merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    const nodes = (patches(calls)[0]?.graph as { nodes: Array<{ type: string; config: unknown }> }).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: 'core.data', config: MERGE_CONFIG });
  });
});

describe('WorkflowStudioEditor — the inspector (TASK-1036 §8.4 item 8)', () => {
  const wired = () =>
    definition({
      graph: {
        version: 1,
        nodes: [
          { id: 'n1', type: 'core.data', config: {}, position: { x: 0, y: 0 } },
          { id: 'n2', type: 'core.data', config: {}, position: { x: 200, y: 0 } },
        ],
        edges: [{ id: 'e1', from: 'n1', fromPort: 'next', to: 'n2', toPort: 'after' }],
      },
    });

  it('opens when a LINK is selected, so the edge inspector is reachable', async () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);

    expect(screen.queryByTestId('inspector-stub')).toBeNull();
    act(() => {
      (canvas.last?.onEdgeSelect as (id: string | null) => void)('e1');
    });
    await waitFor(() => expect(screen.getByTestId('inspector-stub')).toBeTruthy());
    expect(inspector.last?.node).toBeNull();
  });

  it('is fed the Test tab’s last run per node', () => {
    installFetchMock();
    lastRuns.value = { n1: { inputs: { message: 'hi' }, outputs: { text: 'ok' }, durationMs: 12, status: 'COMPLETED' } };
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);

    act(() => {
      (canvas.last?.onSelect as (id: string | null) => void)('n1');
    });
    expect(lastRuns.calledWith).toContain('d-1');
    expect(inspector.last?.lastRunByNode).toBe(lastRuns.value);
  });

  it('is no longer handed the retired secondary-binding props (the composer’s Inputs panel owns bindings)', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[DATA]} />);
    act(() => {
      (canvas.last?.onSelect as (id: string | null) => void)('n2');
    });
    expect(inspector.last?.onSecondaryInputChange).toBeUndefined();
    expect(inspector.last?.secondaryBindings).toBeUndefined();
  });
});

describe('WorkflowStudioEditor — "Edit as new draft" (TASK-1036 §3.4)', () => {
  it('POSTs …/:id/draft and opens the new draft', async () => {
    const calls = installFetchMock((call) =>
      call.method === 'POST' && call.url.includes('/draft') ? Response.json(definition({ id: 'd-9', versionNumber: 3, status: 'DRAFT' })) : undefined,
    );
    renderWithProviders(<WorkflowStudioEditor definition={definition({ status: 'PUBLISHED', isActive: true })} etag='"1"' registryNodes={[]} />);

    fireEvent.click(screen.getByRole('button', { name: /edit as new draft/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-studio/d-9'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toMatch(/\/admin\/workflow-definitions\/d-1\/draft$/);
  });

  it('on 409 OPEN_DRAFT_EXISTS opens the lineage’s existing draft', async () => {
    installFetchMock((call) =>
      call.method === 'POST' && call.url.includes('/draft')
        ? Response.json({ statusCode: 409, message: 'Already has an open draft', error: 'Conflict', code: 'OPEN_DRAFT_EXISTS', draftId: 'd-open' }, { status: 409 })
        : undefined,
    );
    renderWithProviders(<WorkflowStudioEditor definition={definition({ status: 'PUBLISHED', isActive: true })} etag='"1"' registryNodes={[]} />);

    fireEvent.click(screen.getByRole('button', { name: /edit as new draft/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-studio/d-open'));
  });
});
