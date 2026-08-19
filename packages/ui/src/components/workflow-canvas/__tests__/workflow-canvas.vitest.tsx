import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from '../types';

expect.extend(axeMatchers);

beforeAll(() => {
  // happy-dom has no layout engine, so getBoundingClientRect() reports 0×0 and React Flow
  // keeps every node `visibility: hidden` until it has been measured. Give every element a
  // fixed box, mirroring the shim in `data-grid/__tests__/data-grid.vitest.tsx`.
  Element.prototype.getBoundingClientRect = function () {
    return { width: 180, height: 80, top: 0, left: 0, right: 180, bottom: 80, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  // React Flow's own dimension read is `node.offsetWidth`/`offsetHeight`
  // (`@xyflow/system`'s `getDimensions`), not `getBoundingClientRect` — both need stubbing.
  for (const prop of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => (prop.endsWith('Width') ? 180 : 80) });
  }
  // React Flow's node/pane measurement is ResizeObserver-driven, not just
  // getBoundingClientRect-driven (`useNodeObserver` -> `resizeObserver.observe(nodeRef)` ->
  // callback reads `entry.target.getBoundingClientRect()`). happy-dom's own ResizeObserver
  // never fires without real layout, so nodes would stay hidden forever — this polyfill
  // invokes the callback once, synchronously, on every `observe()` call.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      // Deferred, not synchronous: a real ResizeObserver fires after layout settles, well
      // after mount effects (including React Flow's own `domNode` ref effect) have run. Firing
      // synchronously here would race ahead of that and silently no-op the internals update.
      queueMicrotask(() => {
        this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
      });
    }
    unobserve() {}
    disconnect() {}
  };
});

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
}

const NODES: WorkflowCanvasNode[] = [
  { id: 'ingest', type: 'stt.ingest', label: 'Ingest audio', position: { x: 0, y: 0 }, safetyClasses: ['mandatory'] },
  {
    id: 'summarize',
    type: 'text.summarize',
    label: 'Summarize',
    position: { x: 260, y: 0 },
    problem: { severity: 'ERROR', messages: ['Missing required field: prompt template'] },
  },
];

const EDGES: WorkflowCanvasEdge[] = [{ id: 'ingest-summarize', source: 'ingest', target: 'summarize' }];

describe('WorkflowCanvas', () => {
  beforeEach(() => {
    setReducedMotion(false);
  });

  // Regression: the Studio rebuilds its `nodes` array on every render (it maps store nodes into
  // `WorkflowCanvasNode`s), and React Flow's `adoptUserNodes` re-reads `measured` off each user
  // node whenever the object identity changes. When the composite forwarded React Flow's
  // `dimensions` changes to `onNodesChange`, measuring a node looked like an authored edit: the
  // consumer wrote it back, the array identity changed, `measured` was wiped, and the node went
  // back to `visibility: hidden` — a permanently blank-looking canvas over a populated graph.
  // Measurement is the composite's own bookkeeping and must never reach the consumer.
  it('absorbs React Flow dimension measurements instead of reporting them as authored changes', async () => {
    const onNodesChange = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onNodesChange={onNodesChange} />);

    const ingest = await screen.findByRole('group', { name: 'Ingest audio' });
    await waitFor(() => expect(ingest.style.visibility).not.toBe('hidden'));
    // Nothing was dragged, added or deleted — measurement alone must not look like an edit.
    expect(onNodesChange).not.toHaveBeenCalled();
  });

  it('keeps nodes visible when the consumer rebuilds the nodes array on every render', async () => {
    function Consumer() {
      const [, forceRender] = React.useState(0);
      // A fresh array of fresh objects each render — exactly what the Studio does.
      const nodes = NODES.map((node) => ({ ...node }));
      return (
        <>
          <button type="button" onClick={() => forceRender((n) => n + 1)}>
            re-render
          </button>
          <WorkflowCanvas nodes={nodes} edges={EDGES} aria-label="Workflow canvas" />
        </>
      );
    }

    render(<Consumer />);
    const ingest = await screen.findByRole('group', { name: 'Ingest audio' });
    await waitFor(() => expect(ingest.style.visibility).not.toBe('hidden'));

    fireEvent.click(screen.getByRole('button', { name: 're-render' }));

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Ingest audio' }).style.visibility).not.toBe('hidden');
    });
  });

  it('renders one node element per model node, addressable by its label', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    expect(await screen.findByRole('group', { name: 'Ingest audio' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Summarize' })).toBeInTheDocument();
  });

  it('renders the authored edges', async () => {
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    await screen.findByRole('group', { name: 'Summarize' });
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1));
  });

  it('carries the workflow-canvas data-slot on the root and workflow-node on every node', () => {
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    expect(container.querySelector('[data-slot="workflow-canvas"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="workflow-node"]')).toHaveLength(2);
  });

  it('makes every node keyboard-reachable with an accessible name', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    const ingest = await screen.findByRole('group', { name: 'Ingest audio' });
    const summarize = await screen.findByRole('group', { name: 'Summarize' });
    expect(ingest).toHaveAttribute('tabindex', '0');
    expect(summarize).toHaveAttribute('tabindex', '0');
  });

  it('points a problem node at its validation summary via aria-describedby', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    const summarize = await screen.findByRole('group', { name: 'Summarize' });
    const describedById = summarize.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById as string)?.textContent).toContain('Missing required field: prompt template');
  });

  it('gives the canvas region an accessible name via role="application"', () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    expect(screen.getByRole('application', { name: 'Workflow canvas' })).toBeInTheDocument();
  });

  it('never renders drag as the only mutation path — every node exposes a keyboard delete affordance', async () => {
    const onDeleteRequest = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onDeleteRequest={onDeleteRequest} />);
    // A real <button>, not a drag gesture (WCAG 2.5.7 single-pointer/keyboard alternative).
    const removeButtons = await screen.findAllByRole('button', { name: /remove/i });
    expect(removeButtons.length).toBeGreaterThan(0);
  });

  it('refuses no deletion itself — mandatory nodes render no remove affordance; onDeleteRequest never fires for them', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onDeleteRequest={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /remove summarize/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove ingest audio/i })).not.toBeInTheDocument();
  });

  it('exposes zoom and fit-view as real labeled buttons, not drag-only gestures', () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fit view/i })).toBeInTheDocument();
  });

  it('suppresses the fit-view animation duration under prefers-reduced-motion', () => {
    setReducedMotion(true);
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    expect(container.querySelector('[data-slot="workflow-canvas"]')).toHaveAttribute('data-reduced-motion', 'true');
  });

  it('does not suppress motion when the OS preference is off', () => {
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    expect(container.querySelector('[data-slot="workflow-canvas"]')).toHaveAttribute('data-reduced-motion', 'false');
  });

  it('renders a visually-hidden keyboard usage hint', () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    expect(screen.getByText(/structured list view/i)).toBeInTheDocument();
  });

  it('has zero axe violations in light mode', async () => {
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });

  it('has zero axe violations in dark mode', async () => {
    document.documentElement.classList.add('dark');
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
    document.documentElement.classList.remove('dark');
  });
});
