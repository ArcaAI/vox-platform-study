/**
 * `WorkflowStudioEditor` — TASK-893, the one studio.
 *
 * The cases here pin the four things the owner reported as broken and the save model that
 * replaced autosave:
 *  - a PUBLISHED version is INERT on BOTH add paths (palette click and pane drop). Before this
 *    ticket the click path mutated the store while the drop path refused, so the two disagreed
 *    about the same `readOnly` rule and the click produced an edit that could never be saved;
 *  - a node MOVE marks the graph dirty and is written by SAVE — never by a timer (OD-7);
 *  - Discard reverts to the last saved graph;
 *  - deleting a CONNECTION reaches the store (it was impossible on the canvas at all — the List
 *    view was the only way, and that view is deleted);
 *  - one user-drawn link resolves to real sockets (`out` -> `in`), not to whatever handles the
 *    pointer happened to carry.
 *
 * `WorkflowStudioEditor` takes `definition`/`etag`/`registryNodes` as plain props (no query of
 * its own), so it is testable directly without a `WorkingTenantGate`/session stub.
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkflowStudioEditor } from '../workflow-studio-editor';
import type { WorkflowDefinition, WorkflowNodeDescriptor } from '../../api/types';

const push = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

/**
 * Seams onto the canvas's callbacks. React Flow cannot be pointer-dragged in jsdom (it needs a
 * measured viewport), so the drag, drop, connect and edge-delete paths are exercised by calling
 * the very callbacks the real canvas calls. `capturedCanvasProps` also lets the mapping
 * assertions (step numbers, branch handles, single-socket flags) read what the editor computed.
 */
interface CanvasStubProps {
  nodes?: readonly Record<string, unknown>[];
  edges?: readonly Record<string, unknown>[];
  emptyState?: ReactNode;
  onNodesChange?: (next: { id: string; position: { x: number; y: number } }[]) => void;
  onPaneDrop?: (event: { dataTransfer: DataTransfer | null }, position: { x: number; y: number }) => void;
  onEdgeDelete?: (edgeId: string) => void;
  onNodeParentChange?: (nodeId: string, parentId: string | null, position: { x: number; y: number }) => void;
  onConnect?: (connection: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) => void;
}
let capturedCanvasProps: CanvasStubProps | null = null;
vi.mock('@arcaai/ui/components/workflow-canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/ui/components/workflow-canvas')>();
  return {
    ...actual,
    WorkflowCanvas: (props: CanvasStubProps) => {
      capturedCanvasProps = props;
      // Keep the one observable behaviour the other cases rely on: an empty graph renders the
      // canvas's own empty state.
      return <div data-testid="canvas-stub">{(props.nodes?.length ?? 0) === 0 ? props.emptyState : null}</div>;
    },
  };
});

/**
 * The palette is Lane B's; what THIS file owns is the `readOnly` gate on `onAddNode`. The stub is
 * one button that calls the callback with a real descriptor, so the gate is tested rather than
 * the card markup.
 */
vi.mock('../palette', () => ({
  PaletteRail: ({ descriptors, onAddNode }: { descriptors: WorkflowNodeDescriptor[]; onAddNode: (d: WorkflowNodeDescriptor) => void }) => (
    <button type="button" onClick={() => descriptors[0] && onAddNode(descriptors[0])}>
      palette add
    </button>
  ),
}));

/** The inspector is Lane B's; the editor's contract with it is the props it hands over. */
let capturedInspectorProps: Record<string, unknown> | null = null;
vi.mock('../inspector', () => ({
  InspectorPanel: (props: Record<string, unknown>) => {
    capturedInspectorProps = props;
    // The real panel renders exactly one tab's slot at a time; the stub does the same so the
    // editor's `problemsSlot`/`runSlot` composition is exercised rather than merely handed over.
    const body = props.tab === 'problems' ? props.problemsSlot : props.tab === 'run' ? props.runSlot : null;
    return <div data-testid="inspector-stub">{body as ReactNode}</div>;
  },
}));

vi.mock('@/shared/sandbox', () => ({
  SandboxRunPanel: (props: { blockedReason?: string | null }) => <div data-testid="sandbox-run-panel" data-blocked={props.blockedReason ?? ''} />,
  SandboxNodeTrace: () => <div data-testid="sandbox-node-trace" />,
  useSandboxNodeStates: () => new Map(),
}));

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'd-1',
    tenantId: 'tnt-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'summarization',
    versionNumber: 1,
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
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    version: 1,
    tags: [],
    ...overrides,
  };
}

function descriptor(type: string, overrides: Partial<WorkflowNodeDescriptor> = {}): WorkflowNodeDescriptor {
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
    ...overrides,
  };
}

const NOTE = descriptor('core.note', { classes: ['annotation'] });
/** A graph entry: one primary data output, no input — `primaryIoFor` should report `hasInput: false`. */
const TRIGGER = descriptor('core.trigger', {
  classes: ['mandatory'],
  outputs: [
    { name: 'out', primitive: 'text', required: false, multiple: true },
    { name: 'next', primitive: 'control', required: false, multiple: true },
  ],
});
/** A terminal: one primary data input, no output. */
const OUTPUT = descriptor('core.output', {
  inputs: [
    { name: 'in', primitive: 'text', required: true, multiple: true },
    { name: 'after', primitive: 'control', required: false, multiple: true },
  ],
});

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchMock(responder?: (call: RecordedCall) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      if (call.url.includes('/prompt-bindings')) return Response.json([]);
      return responder ? responder(call) : Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    }),
  );
  return calls;
}

function patchBodies(calls: RecordedCall[]) {
  return calls.filter((call) => call.method === 'PATCH').map((call) => call.body as { graph?: { nodes: unknown[]; edges: unknown[] }; name?: string });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
  push.mockClear();
  replace.mockClear();
  refresh.mockClear();
  capturedCanvasProps = null;
  capturedInspectorProps = null;
});

/**
 * The headline defect. 11 of the 12 seeded definitions are PUBLISHED, and `readOnly` disabled
 * every canvas gesture in one line while the only explanation was a sentence of muted text.
 */
describe('WorkflowStudioEditor — a read-only version is inert AND says so (TASK-893 §3.8)', () => {
  it('refuses a palette CLICK on a published definition — the path that used to mutate the store', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition({ status: 'PUBLISHED' })} etag='"1"' registryNodes={[NOTE]} />);

    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));

    expect(screen.getByText('0 nodes · 0 connections')).toBeTruthy();
    expect(screen.getByText(/read-only version/i)).toBeTruthy();
  });

  it('refuses a pane DROP on a published definition (unchanged behaviour, now matching the click path)', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition({ status: 'PUBLISHED' })} etag='"1"' registryNodes={[NOTE]} />);

    act(() => {
      capturedCanvasProps?.onPaneDrop?.(
        { dataTransfer: { getData: () => 'core.note' } as unknown as DataTransfer },
        { x: 10, y: 10 },
      );
    });

    expect(screen.getByText('0 nodes · 0 connections')).toBeTruthy();
  });

  it('explains the lock and offers "Edit as new draft" as the way forward, not a muted sentence', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition({ status: 'PUBLISHED' })} etag='"1"' registryNodes={[NOTE]} />);

    // The banner is a live region and says WHY, rather than a muted sentence with no way out.
    expect(screen.getByRole('status').textContent).toMatch(/locked/i);
    expect(screen.getByText(/palette locked/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /edit as new draft/i })).toBeTruthy();
    // Save/Discard/Undo/Redo have nothing to act on and are not rendered at all.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('"Edit as new draft" POSTs with parentVersionId then navigates to the new draft', async () => {
    const calls = installFetchMock((call) => {
      if (call.method === 'POST') return Response.json({ ...definition({ id: 'd-2', versionNumber: 2, status: 'DRAFT' }) });
      return Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    });
    renderWithProviders(<WorkflowStudioEditor definition={definition({ status: 'PUBLISHED', isActive: true })} etag='"1"' registryNodes={[]} />);

    fireEvent.click(screen.getByRole('button', { name: /edit as new draft/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-studio/d-2'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ slug: 'discharge_summary', paletteKey: 'summarization', parentVersionId: 'd-1' });
  });
});

/**
 * OD-7 — explicit Save, no autosave. `moveNode` now marks the graph dirty, which is what makes a
 * drag survivable at all: with the autosave side-channel gone, a move that is not dirty is a move
 * that is silently lost on reload.
 */
describe('WorkflowStudioEditor — save model (TASK-893 OD-7)', () => {
  const withNode = () =>
    definition({ graph: { version: 1, nodes: [{ id: 'n1', type: 'core.note', config: {}, position: { x: 0, y: 0 } }], edges: [] } });

  it('a canvas drag marks the graph dirty and writes NOTHING until Save is pressed', async () => {
    vi.useFakeTimers();
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    act(() => {
      capturedCanvasProps?.onNodesChange?.([{ id: 'n1', position: { x: 400, y: 250 } }]);
    });

    expect(screen.getByText(/unsaved changes — press save/i)).toBeTruthy();
    // The old debounce was 1s. Five seconds of nothing is the whole point of OD-7.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('Save writes the moved position with If-Match, and the footer settles', async () => {
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    act(() => {
      capturedCanvasProps?.onNodesChange?.([{ id: 'n1', position: { x: 400, y: 250 } }]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchBodies(calls)).toHaveLength(1));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as { graph: { nodes: { position: unknown }[] } }).graph.nodes[0].position).toEqual({ x: 400, y: 250 });
    expect(patch?.headers['if-match']).toBe('"1"');
    await waitFor(() => expect(screen.getByText('All changes saved.')).toBeTruthy());
  });

  it('Discard reverts to the last saved graph once the confirmation is accepted', async () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[NOTE]} />);

    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));
    expect(screen.getByText('1 node · 0 connections')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(await screen.findByRole('button', { name: /discard changes/i }));

    await waitFor(() => expect(screen.getByText('0 nodes · 0 connections')).toBeTruthy());
    expect(screen.getByText('All changes saved.')).toBeTruthy();
  });

  it('the metadata form stages its edit for the SAME Save instead of scheduling its own PATCH', async () => {
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />);

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Discharge Summary v2' } });

    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    // The dialog is MODAL, so Radix marks the rest of the page `aria-hidden` and the toolbar is
    // unreachable by role while it is open — as it should be. Close it the way an admin does, then
    // press the one Save that writes the name and the graph together.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBodies(calls)[0]?.name).toBe('Discharge Summary v2'));
  });

  it('guards an unsaved buffer against a closed tab, and does not nag when there is nothing to lose', () => {
    installFetchMock();
    const { unmount } = renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[NOTE]} />);

    const clean = new Event('beforeunload', { cancelable: true });
    const cleanPrevent = vi.spyOn(clean, 'preventDefault');
    act(() => {
      window.dispatchEvent(clean);
    });
    expect(cleanPrevent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));
    const dirty = new Event('beforeunload', { cancelable: true });
    const dirtyPrevent = vi.spyOn(dirty, 'preventDefault');
    act(() => {
      window.dispatchEvent(dirty);
    });
    expect(dirtyPrevent).toHaveBeenCalled();
    unmount();
  });
});

/**
 * TASK-893 §2.2 — the Studio never handed the canvas an edge-change channel, so every edge
 * `remove` was dropped on the floor and the List view was the ONLY way to unwire two nodes. That
 * view is deleted, so this callback is now the single deletion channel for edges.
 */
describe('WorkflowStudioEditor — deleting a connection (TASK-893 §6.7)', () => {
  const wired = () =>
    definition({
      graph: {
        version: 1,
        nodes: [
          { id: 'n1', type: 'core.trigger', config: {}, position: { x: 0, y: 0 } },
          { id: 'n2', type: 'core.output', config: {}, position: { x: 200, y: 0 } },
        ],
        edges: [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' }],
      },
    });

  it('onEdgeDelete removes the edge from the store and marks the graph dirty', async () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={wired()} etag='"1"' registryNodes={[TRIGGER, OUTPUT]} />);

    expect(screen.getByText('2 nodes · 1 connection')).toBeTruthy();
    act(() => {
      capturedCanvasProps?.onEdgeDelete?.('e1');
    });

    await waitFor(() => expect(screen.getByText('2 nodes · 0 connections')).toBeTruthy());
    expect(screen.getByText(/unsaved changes — press save/i)).toBeTruthy();
  });
});

/**
 * OD-4 — one user-drawn link, sockets resolved underneath. The canvas now renders a single
 * primary dot per side and reports a connection with no meaningful handles; the editor resolves
 * that to the real wire ports through `resolvePrimarySockets`, so `WorkflowGraphEdge` keeps its
 * `fromPort`/`toPort` and the server-side type lattice keeps working unchanged.
 */
describe('WorkflowStudioEditor — socket resolution on connect (TASK-893 §6.6)', () => {
  const twoNodes = () =>
    definition({
      graph: {
        version: 1,
        nodes: [
          { id: 'n1', type: 'core.trigger', config: {}, position: { x: 0, y: 0 } },
          { id: 'n2', type: 'core.output', config: {}, position: { x: 200, y: 0 } },
        ],
        edges: [],
      },
    });

  it('a handle-less connection becomes an edge on the primary data pair', async () => {
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={twoNodes()} etag='"1"' registryNodes={[TRIGGER, OUTPUT]} />);

    act(() => {
      capturedCanvasProps?.onConnect?.({ source: 'n1', sourceHandle: null, target: 'n2', targetHandle: null });
    });
    await waitFor(() => expect(screen.getByText('2 nodes · 1 connection')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBodies(calls)).toHaveLength(1));
    expect(patchBodies(calls)[0]?.graph?.edges[0]).toMatchObject({ from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' });
  });

  it('maps the graph onto the single-socket canvas shape — entry nodes lose their input dot, terminals their output', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={twoNodes()} etag='"1"' registryNodes={[TRIGGER, OUTPUT]} />);

    const canvasNodes = capturedCanvasProps?.nodes as ReadonlyArray<Record<string, unknown>>;
    expect(canvasNodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    expect(canvasNodes[0]).toMatchObject({ hasInput: false, hasOutput: true });
    expect(canvasNodes[1]).toMatchObject({ hasInput: true, hasOutput: false });
    // The removed per-port grid: the canvas is never handed a `ports` bag any more.
    expect(canvasNodes[0].ports).toBeUndefined();
    // OD-4's other half — the badge that presents execution order.
    expect(canvasNodes[0].stepNumber).toBe(1);
  });
});

/**
 * OD-3 — testing lives in the studio. The Workbench deep link is gone; the Run tab carries the
 * fixture picker, and a sandbox run executes the SERVER's graph, so unsaved edits are a stated
 * reason rather than a silent mismatch with what is on the canvas.
 */
describe('WorkflowStudioEditor — the inspector composition (TASK-893 §6.8)', () => {
  it('opens the rail on Test and blocks the run while the buffer is dirty', async () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[NOTE]} />);

    // The rail is collapsed with nothing selected, so the canvas gets the width.
    expect(screen.queryByTestId('inspector-stub')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));

    await waitFor(() => expect(screen.getByTestId('inspector-stub')).toBeTruthy());
    expect(capturedInspectorProps?.tab).toBe('run');
    expect(screen.getByTestId('sandbox-run-panel').getAttribute('data-blocked')).toMatch(/save your changes first/i);
  });

  it('no longer links out to the Workbench', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />);
    expect(screen.queryByRole('link', { name: /workbench/i })).toBeNull();
  });
});

/**
 * Collapsing the node chrome to one input dot and one output dot deleted the `after`/`next`
 * handles. React Flow drops an edge whose named handle does not exist, so an ORDERING edge
 * rendered as nothing — the graph looked disconnected while the wire data was intact. Every
 * seeded graph is built out of `next -> after` edges, so this was the common case, not an edge
 * case. Caught against the running app, not by a unit test, because the fixtures here all wired
 * `out -> in`; this is that gap closed.
 */
describe('WorkflowStudioEditor — ordering edges survive the socket collapse (TASK-893)', () => {
  function definitionWithOrderingEdge(): WorkflowDefinition {
    const base = definition();
    return {
      ...base,
      graph: {
        nodes: [
          { id: 'n1', type: 'core.trigger', config: {}, position: { x: 0, y: 0 } },
          { id: 'n2', type: 'core.note', config: {}, position: { x: 200, y: 0 } },
        ],
        edges: [{ id: 'e1', from: 'n1', fromPort: 'next', to: 'n2', toPort: 'after' }],
      },
    } as WorkflowDefinition;
  }

  it('renders an ordering edge on the primary handles the canvas actually has', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definitionWithOrderingEdge()} etag='"1"' registryNodes={[TRIGGER, NOTE]} />);

    // The canvas stub records the edges it was handed. `next`/`after` must have been projected
    // onto `out`/`in`; leaving them verbatim is what made the edge disappear.
    const edge = capturedCanvasProps?.edges?.[0];
    expect(edge).toMatchObject({ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out', targetHandle: 'in' });
  });

  it('leaves the STORE edge on its real wire sockets — only the drawing is projected', async () => {
    const installedCalls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definitionWithOrderingEdge()} etag='"1"' registryNodes={[TRIGGER, NOTE]} />);

    // The canvas gets the projection; the graph the editor would SAVE keeps the real sockets.
    fireEvent.click(screen.getByRole('button', { name: 'palette add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBodies(installedCalls)[0]?.graph?.edges?.[0]).toMatchObject({ fromPort: 'next', toPort: 'after' }));
  });
});
