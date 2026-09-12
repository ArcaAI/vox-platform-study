/**
 * Frame N.1 — Run trace screen.
 *
 * The structured `?view=list` peer is exercised with the REAL components
 * (no canvas-specific DOM measurement polyfill needed) and carries the axe
 * scan (AC: 0 violations) — it renders every element the canvas view also
 * renders (header, failure panel, footer, node badges) except the xyflow
 * canvas DOM itself, which carries its OWN axe suite in
 * `packages/ui/src/components/workflow-canvas/__tests__/workflow-canvas.vitest.tsx`.
 * One dedicated canvas-view test (with the same ResizeObserver/
 * getBoundingClientRect polyfill that suite uses, since happy-dom has no
 * layout engine) proves the overlay wiring end-to-end in the real composite.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { RunTrace, WorkflowDefinitionSlice, WorkflowRunDetail } from '../../api/types';
import { RunTraceScreen } from '../run-trace-screen';
import { installFetchStub, sessionPayload, type RecordedCall } from './fetch-stub';

const RUN_ID = 'run-1';

const TRACE: RunTrace = {
  run: {
    id: 'wr-1',
    tenantId: 'tnt-1',
    workflowVersionId: 'wfv-1',
    workflowSlug: 'triage',
    workflowVersionNumber: 3,
    definitionName: 'Triage Workflow',
    sessionId: 'workflow-interpreter-run-1',
    runId: RUN_ID,
    trigger: 'api invoke',
    status: 'FAILED',
    isSandbox: false,
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:01:00.000Z',
    durationMs: 60_000,
    nodeCount: 2,
    failedNodeCount: 1,
    degradedNodeCount: 0,
    firstErrorCode: 'boom',
    createdAt: '2026-08-16T10:01:00.000Z',
  },
  nodes: [
    {
      nodeType: 'interpreter.noop',
      order: 0,
      status: 'OK',
      startedAt: '2026-08-16T10:00:00.000Z',
      endedAt: '2026-08-16T10:00:01.000Z',
      durationMs: 1000,
      errorCode: null,
      attemptSeqs: [0],
      attemptCount: 1,
      attemptGroupingIsDerived: true,
    },
    {
      nodeType: 'interpreter.passthrough',
      order: 1,
      status: 'ERROR',
      startedAt: '2026-08-16T10:00:01.000Z',
      endedAt: '2026-08-16T10:00:02.000Z',
      durationMs: 1000,
      errorCode: 'boom',
      attemptSeqs: [1, 2],
      attemptCount: 2,
      attemptGroupingIsDerived: true,
    },
  ],
  stepCount: 3,
  truncated: false,
  tracePruned: false,
};

const DEFINITION: WorkflowDefinitionSlice = {
  id: 'wfv-1',
  slug: 'triage',
  name: 'Triage Workflow',
  versionNumber: 3,
  status: 'PUBLISHED',
  graph: {
    version: 1,
    nodes: [
      { id: 'n1', type: 'interpreter.noop', config: {} },
      { id: 'n2', type: 'interpreter.passthrough', config: {} },
    ],
    edges: [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'in' }],
  },
};

/** GET /admin/workflow-runs/:runId (TASK-959 — `cpuSeconds` beside the run row). `null` by default: most runs predate the metering interceptor. */
const RUN_DETAIL: WorkflowRunDetail = { ...TRACE.run, cpuSeconds: null };

function stubRoutes(overrides: { trace?: RunTrace; runDetail?: WorkflowRunDetail } = {}) {
  return installFetchStub(({ url, method }: RecordedCall) => {
    if (url === '/api/auth/session') return sessionPayload({});
    if (url.includes('/users/me/settings')) return method === 'GET' ? [] : { ok: true };
    if (url.startsWith(`/api/hope/admin/workflow-runs/${RUN_ID}/trace`)) return overrides.trace ?? TRACE;
    // Exact match — must not also catch `/trace`, `/gate`, etc. above/below it.
    if (url === `/api/hope/admin/workflow-runs/${RUN_ID}`) return overrides.runDetail ?? RUN_DETAIL;
    if (url.startsWith('/api/hope/admin/workflow-definitions/wfv-1')) return DEFINITION;
    return { success: true };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RunTraceScreen — list view (?view=list)', () => {
  it('renders the run header, status and both node rollups in step order', async () => {
    stubRoutes();
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    expect(await screen.findByText('Triage Workflow')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
    expect(await screen.findByText('Noop')).toBeDefined();
    expect(screen.getByText('Passthrough')).toBeDefined();
  });

  it('shows the worker CPU seconds from the run detail (TASK-959)', async () => {
    stubRoutes({ runDetail: { ...RUN_DETAIL, cpuSeconds: 2.418 } });
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    expect(await screen.findByText('2.418 s')).toBeDefined();
  });

  it('shows an em dash with a tooltip when cpuSeconds is null (no CPU samples recorded)', async () => {
    stubRoutes({ runDetail: { ...RUN_DETAIL, cpuSeconds: null } });
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    const dash = await screen.findByLabelText('Worker CPU: no data');
    expect(dash.textContent).toContain('—');
    expect(dash.getAttribute('title')).toBe('No CPU samples recorded for this run.');
  });

  it('shows the same em dash when the gateway carries no cpuSeconds field at all', async () => {
    stubRoutes({ runDetail: { ...TRACE.run } as unknown as WorkflowRunDetail });
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    expect(await screen.findByLabelText('Worker CPU: no data')).toBeDefined();
  });

  it('renders the failure panel for a run with a failed node', async () => {
    stubRoutes();
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    expect(await screen.findByText(/node.*failed/i)).toBeDefined();
    expect(screen.getByText(/boom/)).toBeDefined();
  });

  it('opens the node detail drawer with the attempt group when a rollup is selected', async () => {
    stubRoutes();
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    const passthroughButton = await screen.findByRole('button', { name: /Passthrough/ });
    passthroughButton.click();
    expect(await screen.findByText('2 attempts')).toBeDefined();
    // The drawer opens on the Output tab by default (lane C step 6's Input/Output/Error
    // rewrite); the generic "Payload not available" notice is now per-tab ("Output not available").
    expect(screen.getByText(/Output not available/)).toBeDefined();
  });

  it('renders the trace-pruned state instead of the timeline when tracePruned is true', async () => {
    stubRoutes({ trace: { ...TRACE, nodes: [], stepCount: 0, tracePruned: true } });
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    expect(await screen.findByText('Trace pruned by retention')).toBeDefined();
    expect(screen.queryByText('Noop')).toBeNull();
  });

  it('has no axe violations', async () => {
    stubRoutes();
    const { container } = renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    await screen.findByText('Triage Workflow');
    await screen.findByText('Passthrough');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme (pattern: changelog-screen.test.tsx)', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubRoutes();
      const { container } = renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
      await screen.findByText('Triage Workflow');
      await screen.findByText('Passthrough');
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});

describe('RunTraceScreen — canvas view (default)', () => {
  beforeAll(() => {
    // happy-dom has no layout engine, so React Flow keeps nodes unmeasured
    // without these — mirrors `workflow-canvas.vitest.tsx`'s own polyfill
    // exactly (the composite this screen reuses verbatim).
    Element.prototype.getBoundingClientRect = function () {
      return { width: 180, height: 80, top: 0, left: 0, right: 180, bottom: 80, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    for (const prop of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => (prop.endsWith('Width') ? 180 : 80) });
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        queueMicrotask(() => {
          this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
        });
      }
      unobserve() {}
      disconnect() {}
    };
  });

  it('renders the pinned version graph through WorkflowCanvas with the run overlay on each node', async () => {
    stubRoutes();
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />);
    expect(await screen.findByRole('group', { name: 'Noop' })).toBeDefined();
    expect(await screen.findByRole('group', { name: 'Passthrough' })).toBeDefined();
    // The overlay badge text renders inside the node — proves the
    // correlation + overlay wiring reaches the real composite, not just the
    // list-view peer.
    await waitFor(() => expect(screen.getAllByText('OK').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText('Error').length).toBeGreaterThan(0));
  });

  it('shows the replay toolbar for a terminal run and has no axe violations, light and dark', async () => {
    stubRoutes();
    const { container } = renderWithProviders(<RunTraceScreen runId={RUN_ID} />);
    expect(await screen.findByRole('button', { name: 'Replay this run' })).toBeDefined();
    await waitFor(() => expect(screen.getAllByText('Error').length).toBeGreaterThan(0));
    expect(await axe(container)).toHaveNoViolations();

    document.documentElement.classList.add('dark');
    try {
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('scrubs the canvas back to an earlier step, hiding not-yet-revealed nodes', async () => {
    stubRoutes();
    renderWithProviders(<RunTraceScreen runId={RUN_ID} />);
    const replayButton = await screen.findByRole('button', { name: 'Replay this run' });
    await waitFor(() => expect(screen.getAllByText('Error').length).toBeGreaterThan(0));

    replayButton.click();
    // At the full step count both badges are still visible — replay opens fully revealed.
    await waitFor(() => expect(screen.getAllByText('OK').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText('Error').length).toBeGreaterThan(0));

    const previousStepButton = await screen.findByRole('button', { name: 'Previous step' });
    previousStepButton.click();
    // Stepping back one (of two) reveals only the first node's rollup — the second node's
    // "Error" badge (and its problem border) must disappear, not just dim.
    await waitFor(() => expect(screen.getAllByText('OK').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByText('Error')).toBeNull());
  });
});

/**
* Instrumented EventSource double (pattern from `transcription-jobs-screen.test.tsx` /
 * `use-event-stream.test.tsx`) — proves the lane C push wiring end to end: a
 *  RUNNING run mints a ticket, opens a stream, and a `workflow.node.failed` frame reaches
 *  both the live activity feed and the per-node problem map without waiting on a REST poll. 
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(name) ?? [];
    this.listeners.set(name, [...existing, listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(type: string, data: string): void {
    const event = { data } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const RUNNING_TRACE: RunTrace = { ...TRACE, run: { ...TRACE.run, status: 'RUNNING', endedAt: null, durationMs: null } };

describe('RunTraceScreen — live stream (RUNNING run)', () => {
  afterEach(() => {
    FakeEventSource.instances = [];
  });

  it('mints a ticket, opens a direct-gateway EventSource, and surfaces a live node.failed frame', async () => {
    installFetchStub(({ url, method }: RecordedCall) => {
      if (url === '/api/auth/session') return sessionPayload({});
      if (url.includes('/users/me/settings')) return method === 'GET' ? [] : { ok: true };
      if (url.startsWith(`/api/hope/admin/workflow-runs/${RUN_ID}/trace`)) return RUNNING_TRACE;
      if (url.startsWith('/api/hope/admin/workflow-definitions/wfv-1')) return DEFINITION;
      if (url === '/api/auth/stream-ticket') return { ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: 'workflow_run:run-1' };
      return { success: true };
    });
    vi.stubGlobal('EventSource', FakeEventSource);

    renderWithProviders(<RunTraceScreen runId={RUN_ID} />, { searchParams: '?view=list' });
    await screen.findByText('Triage Workflow');

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];
    expect(source.url).toContain(`workflows/triage/runs/${RUN_ID}/stream`);
    expect(source.url).toContain('ticket=tkt-1');

    act(() => source.open());
    await waitFor(() => expect(screen.getByText('Live')).toBeDefined());

    const envelope = {
      schemaVersion: 1,
      id: 'evt-1',
      tenantId: 'tnt-1',
      type: 'workflow.node.failed',
      occurredAt: '2026-08-16T10:00:02.000Z',
      correlationId: RUN_ID,
      causationId: null,
      idempotencyKey: 'wf:run:run-1:node:n2:1',
      payload: { nodeId: 'n2', nodeType: 'interpreter.passthrough', status: 'ERROR', reason: 'boom-live' },
    };
    act(() => source.emit('workflow.node.failed', JSON.stringify(envelope)));

    expect(await screen.findByText(/Passthrough failed — boom-live/)).toBeDefined();
  });
});
