/**
 * TASK-1036 C2b — the composer's canvas affordances (§8.4 items 2, 7; §10.1):
 *
 *  - TYPED PORTS: a node may declare its input / output fields (`inputPorts` / `outputPorts`);
 *    each is a labelled handle whose id is the field handle (`in:message`), whose type is a data
 *    attribute and whose SHAPE also encodes the kind (never colour alone), replacing the primary dot.
 *  - `+` ON AN EDGE: `onEdgeInsert` renders a named button at the link's midpoint.
 *  - The edge label still shows the mapping.
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
  {
    id: 'asr',
    type: 'core.agent',
    label: 'Transcribe',
    position: { x: 0, y: 0 },
    inputPorts: [{ id: 'in:audio', label: 'audio', type: 'audio', tone: 'audio', required: true }],
    outputPorts: [
      { id: 'out:transcript', label: 'transcript', type: 'text', tone: 'text' },
      { id: 'out:segments', label: 'segments', type: 'list<segment>', tone: 'list' },
    ],
  },
  {
    id: 'draft',
    type: 'core.agent',
    label: 'Draft note',
    position: { x: 300, y: 0 },
    inputPorts: [
      { id: 'in:message', label: 'message', type: 'text', tone: 'text' },
      { id: 'in:context', label: 'context', type: 'json', tone: 'json' },
    ],
    outputPorts: [{ id: 'out:text', label: 'text', type: 'text', tone: 'text' }],
  },
];
const EDGES: WorkflowCanvasEdge[] = [
  { id: 'asr-draft', source: 'asr', sourceHandle: 'out:transcript', target: 'draft', targetHandle: 'in:message', label: 'transcript → message' },
];

function handleIds(container: HTMLElement, nodeType: string, label: string): (string | null)[] {
  const node = [...container.querySelectorAll(`[data-node-type="${nodeType}"]`)].find((element) => element.textContent?.includes(label)) as HTMLElement;
  return [...node.querySelectorAll('.react-flow__handle')].map((handle) => handle.getAttribute('data-handleid'));
}

describe('WorkflowCanvas — typed ports', () => {
  it('draws one labelled handle per declared field, in place of the primary dots', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} />);
    await waitFor(() => expect(container.querySelectorAll('[data-node-type="core.agent"]')).toHaveLength(2));
    expect(handleIds(container, 'core.agent', 'Transcribe')).toEqual(['in:audio', 'out:transcript', 'out:segments']);
    const segments = container.querySelector('[data-handleid="out:segments"]') as HTMLElement;
    expect(segments.getAttribute('data-port-type')).toBe('list<segment>');
    expect(segments.getAttribute('data-port-tone')).toBe('list');
    expect(segments.getAttribute('title')).toBe('segments · list<segment>');
    expect(container.querySelector('[data-handleid="in:audio"]')?.getAttribute('title')).toBe('audio · audio · required');
    expect(screen.getAllByText('transcript').length).toBeGreaterThan(0);
  });

  it('keeps the primary dots when a node declares no fields', async () => {
    const plain: WorkflowCanvasNode[] = [{ id: 'x', type: 'core.agent', label: 'Pick an agent', position: { x: 0, y: 0 }, inputPorts: [], outputPorts: [] }];
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={plain} edges={[]} />);
    await waitFor(() => expect(container.querySelector('[data-node-type="core.agent"]')).not.toBeNull());
    expect(handleIds(container, 'core.agent', 'Pick an agent')).toEqual(['in', 'out']);
  });

  it('renders the mapping label on the link', async () => {
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} />);
    expect(await screen.findByText('transcript → message')).toBeInTheDocument();
  });
});

describe('WorkflowCanvas — + on an edge', () => {
  it('names the insert button after the link and reports the edge id', async () => {
    const onEdgeInsert = vi.fn();
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} onEdgeInsert={onEdgeInsert} />);
    const button = await screen.findByRole('button', { name: /insert a step between transcribe and draft note/i });
    fireEvent.click(button);
    expect(onEdgeInsert).toHaveBeenCalledWith('asr-draft');
  });

  it('offers no insert on a read-only canvas', async () => {
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} onEdgeInsert={vi.fn()} readOnly />);
    await waitFor(() => expect(document.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /insert a step/i })).not.toBeInTheDocument();
  });

  it('has zero axe violations with typed ports and the insert affordance', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} onEdgeInsert={vi.fn()} onEdgeDelete={vi.fn()} />);
    await screen.findByRole('button', { name: /insert a step/i });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
