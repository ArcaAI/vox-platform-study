/**
 * TASK-893 §3.1 — the canvas shows the MAIN FLOW, not the port list.
 *
 * Replaces `workflow-canvas-ports.vitest.tsx`, which pinned the per-port rendering this ticket
 * deletes (one handle per declared socket, up to 14 on a `core.action`). The coverage it carried
 * for group nodes, the deprecated badge and the minimap is carried forward here unchanged; only
 * the handle expectations changed, because only the presentation changed — the port contract, the
 * compatibility lattice and the interpreter are untouched.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasNode } from '../types';

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
    id: 'cond',
    type: 'core.condition',
    label: 'Route by visit type',
    position: { x: 0, y: 0 },
    branches: [
      { id: 'then', label: 'then' },
      { id: 'else', label: 'else' },
    ],
  },
  { id: 'trigger', type: 'core.trigger', label: 'Trigger', position: { x: 0, y: 200 }, hasInput: false },
  { id: 'output', type: 'core.output', label: 'Output', position: { x: 0, y: 400 }, hasOutput: false },
  { id: 'loop', type: 'core.loop', label: 'Loop', kind: 'group', position: { x: 400, y: 0 } },
  { id: 'body', type: 'core.agent', label: 'Agent', position: { x: 24, y: 56 }, parentId: 'loop' },
  { id: 'legacy', type: 'agent.grammar', label: 'Grammar', position: { x: 0, y: 600 }, deprecated: true },
];

function nodeEl(container: HTMLElement, type: string): HTMLElement {
  return container.querySelector(`[data-node-type="${type}"]`) as HTMLElement;
}

describe('WorkflowCanvas — single-socket rendering', () => {
  it('gives an ordinary node exactly one target dot and one source dot, keyed in/out', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(nodeEl(container, 'agent.grammar')).not.toBeNull());
    const legacy = nodeEl(container, 'agent.grammar');
    const handles = [...legacy.querySelectorAll('.react-flow__handle')];
    expect(handles.map((handle) => handle.getAttribute('data-handleid'))).toEqual(['in', 'out']);
    expect(handles[0].classList.contains('target')).toBe(true);
    expect(handles[1].classList.contains('source')).toBe(true);
  });

  it('omits the input dot on an entry node and the output dot on a terminal node', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(nodeEl(container, 'core.trigger')).not.toBeNull());
    const handleIds = (type: string) =>
      [...nodeEl(container, type).querySelectorAll('.react-flow__handle')].map((handle) => handle.getAttribute('data-handleid'));
    expect(handleIds('core.trigger')).toEqual(['out']);
    expect(handleIds('core.output')).toEqual(['in']);
  });

  it('renders one labelled SOURCE handle per branch, below the primary output, keyed by the wire port name', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(nodeEl(container, 'core.condition')).not.toBeNull());
    const condition = nodeEl(container, 'core.condition');

    // Primary pair first, then the branches in declared order — the id IS the wire's port name,
    // so an edge drawn from `then` already names the socket it leaves by.
    const handles = [...condition.querySelectorAll('.react-flow__handle')];
    expect(handles.map((handle) => handle.getAttribute('data-handleid'))).toEqual(['in', 'out', 'then', 'else']);

    const thenHandle = condition.querySelector('[data-handleid="then"]') as HTMLElement;
    expect(thenHandle.classList.contains('source')).toBe(true);
    // Square, inline geometry — the branch is distinguishable from the round primary dots by
    // shape, never by colour alone.
    expect(thenHandle.classList.contains('workflow-canvas-branch')).toBe(true);

    const column = condition.querySelector('[data-slot="workflow-node-branches"]') as HTMLElement;
    expect(column).not.toBeNull();
    expect(column.getAttribute('role')).toBe('group');
    expect(column.textContent).toContain('then');
    expect(column.textContent).toContain('else');
  });

  it('renders no branch column when the node declares no branches', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(nodeEl(container, 'agent.grammar')).not.toBeNull());
    expect(nodeEl(container, 'agent.grammar').querySelector('[data-slot="workflow-node-branches"]')).toBeNull();
  });

  it('keeps rendering a deprecated registry type, badged as such', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(nodeEl(container, 'agent.grammar')).not.toBeNull());
    expect(nodeEl(container, 'agent.grammar').textContent).toMatch(/deprecated/);
  });

  it('a group node is a sized container and its child is nested under it', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(container.querySelector('[data-node-kind="group"]')).not.toBeNull());
    const groupWrapper = container.querySelector('[data-node-kind="group"]')!.closest('.react-flow__node') as HTMLElement;
    expect(groupWrapper.style.width).toMatch(/px$/);
    expect(Number.parseInt(groupWrapper.style.width, 10)).toBeGreaterThanOrEqual(240);
    // React Flow marks children of a parent with the parent's id in the DOM order: the parent precedes the child.
    const order = [...container.querySelectorAll('.react-flow__node')].map((el) => el.getAttribute('data-id'));
    expect(order.indexOf('loop')).toBeLessThan(order.indexOf('body'));
  });

  it('renders the minimap by default and hides it on request', async () => {
    const { container, rerender } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(container.querySelector('.react-flow__minimap')).not.toBeNull());
    rerender(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} minimap={false} />);
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
  });
});
