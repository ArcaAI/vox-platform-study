/**
 * `WorkflowStudioEditor` — /16 remainder ( "still genuinely NOT done"):
 *  - the metadata form autosaves `name`/`description` the same way `graph` does;
 *  - a PUBLISHED (read-only) row offers "Create new version from this" instead of an edit
 * affordance ( 1: "published rows immutable — edits create versions");
 *  - `?view=list` round-trips through the URL via nuqs, both directions;
 *  - the unsaved-changes guard is actually wired to the combined graph/metadata dirty state.
 *
 * `WorkflowStudioEditor` takes `definition`/`etag`/`registryNodes` as plain props (no query of
 * its own), so it is testable directly without a `WorkingTenantGate`/session stub.
 */
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkflowStudioEditor } from '../workflow-studio-editor';
import type { WorkflowDefinition } from '../../api/types';

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

/**
 * TASK-890/BB4 — a seam onto the canvas's `onNodesChange`. React Flow cannot be pointer-dragged
 * in jsdom (it needs a measured viewport), so the drag path is exercised by calling the very
 * callback the real canvas calls on drag stop. Everything else in `@arcaai/ui/components/
 * workflow-canvas` stays real.
 */
let capturedOnNodesChange: ((next: { id: string; position: { x: number; y: number } }[]) => void) | null = null;
vi.mock('@arcaai/ui/components/workflow-canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/ui/components/workflow-canvas')>();
  return {
    ...actual,
    WorkflowCanvas: (props: {
      nodes?: readonly unknown[];
      emptyState?: ReactNode;
      onNodesChange?: (next: { id: string; position: { x: number; y: number } }[]) => void;
    }) => {
      capturedOnNodesChange = props.onNodesChange ?? null;
      // Keep the one observable behaviour the other cases in this file assert: an empty graph
      // renders the canvas's own empty state.
      return <div data-testid="canvas-stub">{(props.nodes?.length ?? 0) === 0 ? props.emptyState : null}</div>;
    },
  };
});

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
      // DD-11: the editor's right rail reads `:id/prompt-bindings`,
      // which answers an ARRAY. The catch-all definition-row default below
      // would hand it an object and the rail would fail to render — so route
      // that one path explicitly, ahead of any per-test responder's fallback.
      if (call.url.includes('/prompt-bindings')) return Response.json([]);
      return responder ? responder(call) : Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
  push.mockClear();
  refresh.mockClear();
});

describe('WorkflowStudioEditor — view mode <-> URL (Task 16 remainder)', () => {
  it('defaults to the canvas view and switching to List updates the URL to ?view=list', async () => {
    installFetchMock();
    const onUrlUpdate = vi.fn();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />, { onUrlUpdate });

    // Both editors now carry a "No nodes yet" empty state, so the discriminator is the copy:
    // the canvas one points at the palette, the list one at "add a node from the palette to start".
    expect(screen.getByText(/switch to the list view/i)).toBeTruthy(); // canvas is up, not the list editor

    // Radix `ToggleGroupItem` renders `role="radio"` inside the `radiogroup` toolbar, not "button".
    fireEvent.click(screen.getByRole('radio', { name: 'List view' }));

    expect(await screen.findByText(/to start building this workflow/i)).toBeTruthy();
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const lastCall = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
    expect(lastCall.searchParams.get('view')).toBe('list');
  });

  it('hydrates the store from ?view=list on mount (shareable deep link)', async () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />, { searchParams: '?view=list' });
    expect(await screen.findByText(/to start building this workflow/i)).toBeTruthy();
  });
});

describe('WorkflowStudioEditor — create new version from a published row (Task 15 remainder)', () => {
  it('a PUBLISHED row shows "Create new version" (not an edit affordance) and it POSTs with parentVersionId then navigates', async () => {
    const calls = installFetchMock((call) => {
      if (call.method === 'POST') return Response.json({ ...definition({ id: 'd-2', versionNumber: 2, status: 'DRAFT' }) });
      return Response.json({ id: 'd-1', version: 2 }, { headers: { etag: '"2"' } });
    });
    renderWithProviders(
      <WorkflowStudioEditor definition={definition({ status: 'PUBLISHED', isActive: true })} etag='"1"' registryNodes={[]} />,
      {},
    );

    const button = screen.getByRole('button', { name: /create new version/i });
    fireEvent.click(button);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-studio/d-2'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ slug: 'discharge_summary', paletteKey: 'summarization', parentVersionId: 'd-1' });
  });
});

describe('WorkflowStudioEditor — definition metadata form autosaves (Task 15 remainder)', () => {
  it('editing the name in the metadata dialog schedules the SAME debounced autosave PATCH the graph uses', async () => {
    vi.useFakeTimers();
    const calls = installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />, {});

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));
    // `getByLabelText` (not `findBy*`) — the Dialog's content is present synchronously once
    // `open` flips; `findBy*`'s internal `waitFor` polls via `setTimeout`, which never fires
    // under fake timers unless explicitly advanced.
    const nameInput = screen.getByLabelText(/^Name/);
    fireEvent.change(nameInput, { target: { value: 'Discharge Summary v2' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toMatchObject({ name: 'Discharge Summary v2' });
  });
});

describe('WorkflowStudioEditor — unsaved-changes guard (Task 15 remainder)', () => {
  it('prevents beforeunload once the metadata form has an unsaved edit', () => {
    vi.useFakeTimers();
    installFetchMock(() => new Promise(() => {}) as unknown as Response); // never resolves — stays dirty
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />, {});

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));
    const nameInput = screen.getByLabelText(/^Name/);
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });

    const event = new Event('beforeunload', { cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('does NOT prevent beforeunload with no edits', () => {
    installFetchMock();
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />, {});
    const event = new Event('beforeunload', { cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

/**
 * TASK-890/BB4 — a canvas node DRAG must reach the server.
 *
 * `moveNode` deliberately does not set `dirty` (see `create-graph-store.ts`: layout is display
 * bookkeeping, not graph shape), and the graph autosave effect early-returns while `!dirty`. So
 * the canvas's `onNodesChange` — the drag path — silently dropped every layout move: the node
 * moved in the DOM, the footer still read "All changes saved", and a reload restored the old
 * position. `handleAutoLayout` was the only mover that survived a reload, because it schedules
 * the patch itself. This asserts the drag path does the same, which is what the comment above
 * `handleAutoLayout` ("persisted through the same autosave path as a drag would be") claims.
 */
describe('WorkflowStudioEditor — a canvas node drag persists (TASK-890/BB4)', () => {
  it('schedules the debounced graph PATCH when the canvas reports a moved node', async () => {
    vi.useFakeTimers();
    const calls = installFetchMock();
    const withNode = definition({
      graph: { version: 1, nodes: [{ id: 'n1', type: 'core.note', config: {}, position: { x: 0, y: 0 } }], edges: [] },
    });
    renderWithProviders(
      <WorkflowStudioEditor
        definition={withNode}
        etag='"1"'
        registryNodes={[
          {
            type: 'core.note',
            implemented: true,
            classes: ['annotation'],
            paletteKey: 'core',
            deprecated: false,
            entitlementKey: null,
            inputs: [],
            outputs: [],
          } as never,
        ]}
      />,
      {},
    );

    act(() => {
      capturedOnNodesChange?.([{ id: 'n1', position: { x: 400, y: 250 } }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect((patch?.body as { graph: { nodes: { position: unknown }[] } }).graph.nodes[0].position).toEqual({ x: 400, y: 250 });
  });
});
