/**
 * TASK-965 WS-1 — the studio editor's publish / validate / save integrity.
 *
 * Every case here is a defect the tenant admin met on the running console (README §2.4 A/B):
 *  - Validate bumped the row version server-side while the console dropped the returned ETag, so
 *    the canonical edit → Validate → Save loop always 412'd (WF-2);
 *  - Publish went through the raw client + `router.refresh()`, never the studio's query namespace,
 *    so a freshly published version kept rendering as an editable DRAFT (WF-1);
 *  - Publish was offered on a dirty buffer and froze the last SAVED graph instead (WF-5);
 *  - a refused publish was a four-word toast, the gateway's reason lost (WF-6);
 *  - programmatic navigations bypassed the unsaved-changes guard (WF-7);
 *  - a positionless graph opened already "dirty" because the initial layout went through
 *    `moveNode` (WF-8);
 *  - a metadata-only Save still sent the graph and demoted VALIDATED → DRAFT (WF-9);
 *  - after a 412 both `OccConflictAlert` escapes were inert (WF-3);
 *  - an out-of-band ETag change (node prompt edit, refetch) never reached the editor (WF-11).
 *
 * `WorkflowStudioEditor` takes `definition`/`etag`/`registryNodes` as props, so the editor is
 * exercised directly; the network is a recorded `fetch` stub.
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import { WorkflowStudioEditor } from '../workflow-studio-editor';
import type { WorkflowDefinition, WorkflowNodeDescriptor, WorkflowValidationReport } from '../../api/types';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

interface CanvasStubProps {
  nodes?: readonly Record<string, unknown>[];
  emptyState?: ReactNode;
  onNodesChange?: (next: { id: string; position: { x: number; y: number } }[]) => void;
}
let capturedCanvasProps: CanvasStubProps | null = null;
vi.mock('@arcaai/ui/components/workflow-canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/ui/components/workflow-canvas')>();
  return {
    ...actual,
    WorkflowCanvas: (props: CanvasStubProps) => {
      capturedCanvasProps = props;
      return <div data-testid="canvas-stub" />;
    },
  };
});
vi.mock('../palette', () => ({ PaletteRail: () => <div data-testid="palette-stub" /> }));
vi.mock('../inspector', () => ({ InspectorPanel: () => <div data-testid="inspector-stub" /> }));
vi.mock('@/shared/sandbox', () => ({
  SandboxRunPanel: () => <div data-testid="sandbox-run-panel" />,
  SandboxNodeTrace: () => null,
  useSandboxNodeStates: () => new Map(),
}));
// Deterministic layout: a clustered graph is spread 200px apart, anything else is left alone —
// the same contract as the real helper, without dagre in jsdom.
vi.mock('../../lib/ensure-canvas-layout', () => ({
  layoutClusteredGraph: async (nodes: readonly { id: string; position: { x: number; y: number } }[]) => {
    if (nodes.length < 2 || !nodes.every((node) => node.position.x === 0 && node.position.y === 0)) return null;
    return Object.fromEntries(nodes.map((node, index) => [node.id, { x: index * 200, y: 0 }]));
  },
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

function descriptor(type: string): WorkflowNodeDescriptor {
  return {
    type,
    implemented: true,
    activityName: type,
    classes: ['annotation'],
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
const NOTE = descriptor('core.note');

const withNode = (overrides: Partial<WorkflowDefinition> = {}) =>
  definition({ graph: { version: 1, nodes: [{ id: 'n1', type: 'core.note', config: {}, position: { x: 10, y: 10 } }], edges: [] }, ...overrides });

interface RecordedCall {
  url: string;
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchMock(responder: (call: RecordedCall, index: number) => Response | undefined = () => undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const call: RecordedCall = {
        url,
        path: new URL(url, 'http://test.local').pathname,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      if (call.path.endsWith('/prompt-bindings')) return Response.json([]);
      return responder(call, calls.length) ?? Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    }),
  );
  return calls;
}

const patches = (calls: RecordedCall[]) => calls.filter((call) => call.method === 'PATCH');
const moveNode = () =>
  act(() => {
    capturedCanvasProps?.onNodesChange?.([{ id: 'n1', position: { x: 400, y: 250 } }]);
  });
const clickSave = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

async function confirmPublish() {
  fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Publish$/ }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  push.mockClear();
  vi.mocked(toast.error).mockClear();
  capturedCanvasProps = null;
});

describe('WorkflowStudioEditor — validate / publish integrity (TASK-965 WS-1)', () => {
  it('Validate adopts the ETag and status the gateway returns, so the next Save carries the fresh precondition (WF-2)', async () => {
    const calls = installFetchMock((call) => {
      if (call.method === 'POST' && call.path.endsWith('/validate')) {
        return Response.json(withNode({ status: 'VALIDATED', validationReport: OK_REPORT, version: 5 }), { headers: { etag: '"5"' } });
      }
      return undefined;
    });
    renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => expect(screen.getByText('VALIDATED')).toBeTruthy());

    moveNode();
    clickSave();
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].headers['if-match']).toBe('"5"');
  });

  it('Publish runs through the studio query namespace and the editor turns read-only without a reload (WF-1)', async () => {
    installFetchMock((call) => {
      if (call.method === 'POST' && call.path.endsWith('/publish')) {
        return Response.json(withNode({ status: 'PUBLISHED', isActive: true, version: 3, publishedAt: '2026-09-13T06:48:09.600Z' }), { headers: { etag: '"3"' } });
      }
      if (call.method === 'GET' && call.path.endsWith('/schema')) {
        return Response.json({ slug: 'discharge_summary', versionNumber: 1, triggerKinds: ['api'], protocols: ['http'], modes: ['async', 'blocking'] });
      }
      return undefined;
    });
    const { queryClient } = renderWithProviders(<WorkflowStudioEditor definition={withNode({ validationReport: OK_REPORT })} etag='"1"' registryNodes={[NOTE]} />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await confirmPublish();

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['workflow-studio'] })));
    await waitFor(() => expect(screen.getByText(/canvas and palette are locked/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Save', hidden: true })).toBeNull();
    expect(screen.getByText('PUBLISHED')).toBeTruthy();
  });

  it('withholds Publish while the buffer has unsaved changes, and says why (WF-5)', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={withNode({ validationReport: OK_REPORT })} etag='"1"' registryNodes={[NOTE]} />);
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);

    moveNode();

    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/save your changes first/i)).toBeTruthy();
  });

  it('a refused publish surfaces the gateway message, not a generic "Publish failed." (WF-6)', async () => {
    installFetchMock((call) => {
      if (call.method === 'POST' && call.path.endsWith('/publish')) {
        return Response.json({ message: 'The workflow graph does not pass the publish gate.', findings: [] }, { status: 400 });
      }
      return undefined;
    });
    renderWithProviders(<WorkflowStudioEditor definition={withNode({ validationReport: OK_REPORT })} etag='"1"' registryNodes={[NOTE]} />);

    await confirmPublish();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('does not pass the publish gate')));
  });

  it('a failed Save surfaces the gateway message instead of a bare badge (WF-6)', async () => {
    const calls = installFetchMock((call) => {
      if (call.method === 'PATCH') return Response.json({ message: 'Workflow d-1 is PUBLISHED and can no longer be edited.' }, { status: 400 });
      return undefined;
    });
    renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    moveNode();
    clickSave();

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('can no longer be edited')));
  });
});

describe('WorkflowStudioEditor — ETag and buffer discipline (TASK-965 WS-1)', () => {
  it('adopts a changed ETag prop, so an out-of-band refetch never leaves a stale If-Match behind (WF-11)', async () => {
    const calls = installFetchMock();
    const { rerender } = renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    rerender(<WorkflowStudioEditor definition={withNode()} etag='"7"' registryNodes={[NOTE]} />);
    moveNode();
    clickSave();

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].headers['if-match']).toBe('"7"');
  });

  it('lays out a positionless multi-node graph as display bookkeeping, never as an edit (WF-8)', async () => {
    installFetchMock();
    const piled = definition({
      graph: {
        version: 1,
        nodes: [
          { id: 'n1', type: 'core.note', config: {}, position: { x: 0, y: 0 } },
          { id: 'n2', type: 'core.note', config: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
    });
    renderWithProviders(<WorkflowStudioEditor definition={piled} etag='"1"' registryNodes={[NOTE]} />);

    // The layout promise resolves on a later tick; give it that tick, then assert the graph is
    // still CLEAN — spread out, but with nothing to save.
    await waitFor(() => expect((capturedCanvasProps?.nodes?.[1] as { position?: { x: number } } | undefined)?.position?.x).toBe(200));
    expect(screen.getByText('All changes saved.')).toBeTruthy();
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
  });

  it('a metadata-only Save does not send the graph, so a VALIDATED version keeps its status (WF-9)', async () => {
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={withNode({ status: 'VALIDATED', validationReport: OK_REPORT })} etag='"1"' registryNodes={[NOTE]} />);

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Discharge Summary v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    const body = patches(calls)[0].body as { name?: string; graph?: unknown };
    expect(body.name).toBe('Discharge Summary v2');
    expect(body.graph).toBeUndefined();
  });

  it('"New" asks before leaving a dirty buffer, and only navigates on a yes (WF-7)', () => {
    installFetchMock();
    // `window.confirm` is not implemented in this environment — stubbed, and unstubbed in afterEach.
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    moveNode();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(confirm).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(push).toHaveBeenCalledWith('/workflow-studio/new');
  });
});

describe('WorkflowStudioEditor — 412 recovery (TASK-965 WS-1, WF-3)', () => {
  /** First PATCH conflicts; the detail read answers the newer row; later PATCHes succeed. */
  function conflictThenFresh(calls: RecordedCall[]) {
    return (call: RecordedCall): Response | undefined => {
      if (call.method === 'PATCH' && patches(calls).length === 1) return Response.json({ message: 'Precondition Failed' }, { status: 412 });
      if (call.method === 'GET' && /\/admin\/workflow-definitions\/d-1$/.test(call.path)) {
        return Response.json(
          withNode({ version: 3, graph: { version: 1, nodes: [{ id: 'n1', type: 'core.note', config: {}, position: { x: 100, y: 100 } }], edges: [] } }),
          { headers: { etag: '"3"' } },
        );
      }
      return undefined;
    };
  }

  it('"Reload latest" re-hydrates the canvas from the server and the next Save carries the fresh ETag', async () => {
    // Reloading discards the local buffer, so it asks first; the admin says yes here.
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    let calls: RecordedCall[] = [];
    calls = installFetchMock((call) => conflictThenFresh(calls)(call));
    renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    moveNode();
    clickSave();
    await screen.findByText(/412 precondition failed/i);

    fireEvent.click(screen.getByRole('button', { name: /reload latest/i }));
    await waitFor(() => expect(calls.some((call) => call.method === 'GET' && /\/admin\/workflow-definitions\/d-1$/.test(call.path))).toBe(true));
    // The server's graph replaced the buffer: clean, and positioned where the server says.
    await waitFor(() => expect(screen.getByText('All changes saved.')).toBeTruthy());
    expect((capturedCanvasProps?.nodes?.[0] as { position?: { x: number } } | undefined)?.position?.x).toBe(100);

    moveNode();
    clickSave();
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1].headers['if-match']).toBe('"3"');
  });

  it('"Overwrite anyway" re-reads the ETag and re-sends the local buffer', async () => {
    let calls: RecordedCall[] = [];
    calls = installFetchMock((call) => conflictThenFresh(calls)(call));
    renderWithProviders(<WorkflowStudioEditor definition={withNode()} etag='"1"' registryNodes={[NOTE]} />);

    moveNode();
    clickSave();
    await screen.findByText(/412 precondition failed/i);

    fireEvent.click(screen.getByRole('button', { name: /overwrite anyway/i }));

    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    const retry = patches(calls)[1];
    expect(retry.headers['if-match']).toBe('"3"');
    expect((retry.body as { graph: { nodes: { position: unknown }[] } }).graph.nodes[0].position).toEqual({ x: 400, y: 250 });
    await waitFor(() => expect(screen.getByText('All changes saved.')).toBeTruthy());
  });
});
