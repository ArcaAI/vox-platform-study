/**
 * TASK-893 §3.2 / §3.6 — the two pieces of state the node header gained: where it sits in the
 * execution order, and what the sandbox made of it on the last run.
 *
 * Both are rendered as TEXT with their own accessible name. A cycle marker that were only an
 * orange ring, or a run verdict that were only a red chip, would fail rule 11 §10 ("never convey
 * meaning by colour alone") and would be invisible to a screen reader.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasNode } from '../types';

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

function renderNodes(nodes: WorkflowCanvasNode[]) {
  return render(<WorkflowCanvas nodes={nodes} edges={[]} aria-label="Workflow canvas" />);
}

function stepBadge(container: HTMLElement, type: string): HTMLElement | null {
  return container.querySelector(`[data-node-type="${type}"] [data-slot="workflow-node-step"]`);
}

describe('WorkflowNode — step badge', () => {
  it('renders the 1-based execution order with its own accessible name', async () => {
    const { container } = renderNodes([{ id: 'a', type: 'core.agent', label: 'Extract entities', position: { x: 0, y: 0 }, stepNumber: 2 }]);
    await waitFor(() => expect(stepBadge(container, 'core.agent')).not.toBeNull());
    expect(stepBadge(container, 'core.agent')!.textContent).toContain('2');
    expect(screen.getByText('Step 2')).toBeInTheDocument();
  });

  it('renders no badge when the node has no step', async () => {
    const { container } = renderNodes([
      { id: 'a', type: 'core.agent', label: 'Extract entities', position: { x: 0, y: 0 } },
      { id: 'b', type: 'core.output', label: 'Output', position: { x: 0, y: 200 }, stepNumber: null },
    ]);
    await waitFor(() => expect(container.querySelector('[data-node-type="core.agent"]')).not.toBeNull());
    expect(stepBadge(container, 'core.agent')).toBeNull();
    expect(stepBadge(container, 'core.output')).toBeNull();
  });

  it('marks a node in a cycle, and one unreachable from the trigger, with a glyph plus a name', async () => {
    const { container } = renderNodes([
      { id: 'a', type: 'core.loop', label: 'Loop back', position: { x: 0, y: 0 }, stepMarker: 'cycle' },
      { id: 'b', type: 'core.agent', label: 'Orphan', position: { x: 0, y: 200 }, stepMarker: 'unreachable' },
    ]);
    await waitFor(() => expect(stepBadge(container, 'core.loop')).not.toBeNull());

    expect(stepBadge(container, 'core.loop')!.getAttribute('data-step-marker')).toBe('cycle');
    expect(stepBadge(container, 'core.loop')!.textContent).toContain('↻');
    expect(screen.getByText(/in a cycle/i)).toBeInTheDocument();

    expect(stepBadge(container, 'core.agent')!.getAttribute('data-step-marker')).toBe('unreachable');
    expect(stepBadge(container, 'core.agent')!.textContent).toContain('⚠');
    expect(screen.getByText(/unreachable from the trigger/i)).toBeInTheDocument();
  });

  it('prefers the marker over a step number when a node carries both', async () => {
    const { container } = renderNodes([
      { id: 'a', type: 'core.agent', label: 'Both', position: { x: 0, y: 0 }, stepNumber: 3, stepMarker: 'cycle' },
    ]);
    await waitFor(() => expect(stepBadge(container, 'core.agent')).not.toBeNull());
    expect(stepBadge(container, 'core.agent')!.textContent).not.toContain('3');
    expect(screen.queryByText('Step 3')).not.toBeInTheDocument();
  });
});

describe('WorkflowNode — run chip', () => {
  function runChip(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-run-state]');
  }

  it('spells the run state out and exposes it as a labelled value, not a colour', async () => {
    const { container } = renderNodes([{ id: 'a', type: 'core.agent', label: 'Extract', position: { x: 0, y: 0 }, runState: 'failed' }]);
    await waitFor(() => expect(runChip(container)).not.toBeNull());
    expect(runChip(container)!.getAttribute('data-run-state')).toBe('failed');
    expect(runChip(container)!.textContent).toContain('failed');
    expect(screen.getByText(/run state:/i)).toBeInTheDocument();
  });

  it('renders sub-second wall time in milliseconds and longer runs in seconds', async () => {
    const { container: fast } = renderNodes([
      { id: 'a', type: 'core.agent', label: 'Fast', position: { x: 0, y: 0 }, runState: 'ok', runDurationMs: 950 },
    ]);
    await waitFor(() => expect(runChip(fast)).not.toBeNull());
    expect(runChip(fast)!.textContent).toContain('950 ms');

    const { container: slow } = renderNodes([
      { id: 'b', type: 'core.agent', label: 'Slow', position: { x: 0, y: 0 }, runState: 'ok', runDurationMs: 1240 },
    ]);
    await waitFor(() => expect(runChip(slow)).not.toBeNull());
    expect(runChip(slow)!.textContent).toContain('1.2 s');
  });

  it('renders the state alone when no duration was reported', async () => {
    const { container } = renderNodes([{ id: 'a', type: 'core.agent', label: 'Waiting', position: { x: 0, y: 0 }, runState: 'pending' }]);
    await waitFor(() => expect(runChip(container)).not.toBeNull());
    expect(runChip(container)!.textContent).toContain('pending');
    expect(runChip(container)!.textContent).not.toMatch(/ms|\ds/);
  });

  it('renders no chip when the node has no run state', async () => {
    const { container } = renderNodes([{ id: 'a', type: 'core.agent', label: 'Never run', position: { x: 0, y: 0 } }]);
    await waitFor(() => expect(container.querySelector('[data-node-type="core.agent"]')).not.toBeNull());
    expect(runChip(container)).toBeNull();
  });

  it('has zero axe violations with a step badge, a run chip and branch outputs on one node', async () => {
    const { container } = renderNodes([
      {
        id: 'a',
        type: 'core.condition',
        label: 'Route by visit type',
        position: { x: 0, y: 0 },
        stepNumber: 4,
        runState: 'ok',
        runDurationMs: 1240,
        branches: [
          { id: 'then', label: 'then' },
          { id: 'else', label: 'else' },
        ],
      },
    ]);
    await waitFor(() => expect(container.querySelector('[data-slot="workflow-node-branches"]')).not.toBeNull());
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
