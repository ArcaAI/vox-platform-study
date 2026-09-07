/**
 * TASK-893 §2.2 — the pointer/keyboard affordance for deleting a connection.
 *
 * A hover-only control is unusable without a pointer, so the X is mounted for every deletable
 * edge and merely hidden: focusing it reveals it, which makes "delete this connection" reachable
 * by Tab alone (WCAG 2.5.7) alongside the Delete key on a selected edge. Hidden also means
 * `pointer-events-none`, so an invisible button can never swallow a click on the pane beneath it.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from '../types';

expect.extend(axeMatchers);

beforeAll(() => {
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
      queueMicrotask(() => this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver));
    }
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as typeof window.matchMedia;
});

const NODES: WorkflowCanvasNode[] = [
  { id: 'ingest', type: 'stt.ingest', label: 'Ingest audio', position: { x: 0, y: 0 } },
  { id: 'summarize', type: 'text.summarize', label: 'Summarize', position: { x: 260, y: 0 } },
];
const EDGES: WorkflowCanvasEdge[] = [{ id: 'ingest-summarize', source: 'ingest', target: 'summarize' }];

const REMOVE_LABEL = /remove connection from ingest audio to summarize/i;

describe('WorkflowCanvas — edge delete affordance', () => {
  it('names the button after the nodes it connects, not after two ids', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} />);
    expect(await screen.findByRole('button', { name: REMOVE_LABEL })).toBeInTheDocument();
  });

  it('stays hidden and click-through until it is hovered or focused, then reveals itself', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} />);
    const button = await screen.findByRole('button', { name: REMOVE_LABEL });

    expect(button.className).toContain('opacity-0');
    expect(button.className).toContain('pointer-events-none');

    fireEvent.focus(button);
    await waitFor(() => expect(button.className).toContain('opacity-100'));
    expect(button.className).toContain('pointer-events-auto');

    fireEvent.blur(button);
    await waitFor(() => expect(button.className).toContain('opacity-0'));
  });

  it('reports the deletion by edge id and never removes the edge itself', async () => {
    const onEdgeDelete = vi.fn();
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={onEdgeDelete} />);
    const button = await screen.findByRole('button', { name: REMOVE_LABEL });

    fireEvent.click(button);

    expect(onEdgeDelete).toHaveBeenCalledTimes(1);
    expect(onEdgeDelete).toHaveBeenCalledWith('ingest-summarize');
    // The consumer decides; the composite still shows the edge it was given.
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1));
  });

  it('renders no delete affordance on a read-only canvas', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} readOnly />);
    await waitFor(() => expect(document.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: REMOVE_LABEL })).not.toBeInTheDocument();
  });

  it('renders no delete affordance when the consumer wired no deletion channel', async () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" />);
    await waitFor(() => expect(document.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: REMOVE_LABEL })).not.toBeInTheDocument();
  });

  it('keeps rendering an edge label alongside the affordance', async () => {
    const labelled: WorkflowCanvasEdge[] = [{ ...EDGES[0], label: 'then' }];
    render(<WorkflowCanvas nodes={NODES} edges={labelled} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} />);
    expect(await screen.findByText('then')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: REMOVE_LABEL })).toBeInTheDocument();
  });

  it('has zero axe violations with the affordance mounted', async () => {
    const { container } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} />);
    await screen.findByRole('button', { name: REMOVE_LABEL });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
