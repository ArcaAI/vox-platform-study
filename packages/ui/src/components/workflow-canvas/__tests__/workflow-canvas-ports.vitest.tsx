/** TASK-864 B1 — per-port handles, group (loop) nodes, deprecated badge, minimap. */
import { describe, it, expect, beforeAll } from 'vitest';
import * as React from 'react';
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
    label: 'Condition',
    position: { x: 0, y: 0 },
    ports: {
      inputs: [{ id: 'in', kind: 'data', primitive: 'any' }],
      outputs: [
        { id: 'evaluation', kind: 'data', primitive: 'object' },
        { id: 'urgent', kind: 'control', primitive: 'control' },
        { id: 'else', kind: 'control', primitive: 'control' },
      ],
    },
  },
  { id: 'loop', type: 'core.loop', label: 'Loop', kind: 'group', position: { x: 400, y: 0 } },
  { id: 'body', type: 'core.agent', label: 'Agent', position: { x: 24, y: 56 }, parentId: 'loop' },
  { id: 'legacy', type: 'agent.grammar', label: 'Grammar', position: { x: 0, y: 300 }, deprecated: true },
];

describe('WorkflowCanvas — core vocabulary chrome', () => {
  it('renders one handle per declared port, keyed by port id, with kind and primitive exposed', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(container.querySelector('[data-node-type="core.condition"]')).not.toBeNull());
    const condition = container.querySelector('[data-node-type="core.condition"]')!;
    const handles = [...condition.querySelectorAll('.react-flow__handle')];
    expect(handles.map((h) => h.getAttribute('data-handleid'))).toEqual(['in', 'evaluation', 'urgent', 'else']);
    expect(condition.querySelector('[data-handleid="urgent"]')?.getAttribute('data-port-kind')).toBe('control');
    expect(condition.querySelector('[data-handleid="in"]')?.getAttribute('data-port-primitive')).toBe('any');
    expect(condition.querySelector('[data-handleid="in"]')?.classList.contains('target')).toBe(true);
    expect(condition.querySelector('[data-handleid="else"]')?.classList.contains('source')).toBe(true);
  });

  it('a node without ports keeps the legacy single in/out pair', async () => {
    const { container } = render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={[]} />);
    await waitFor(() => expect(container.querySelector('[data-node-type="agent.grammar"]')).not.toBeNull());
    const legacy = container.querySelector('[data-node-type="agent.grammar"]')!;
    expect(legacy.querySelectorAll('.react-flow__handle').length).toBe(2);
    expect(legacy.textContent).toMatch(/deprecated/);
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
