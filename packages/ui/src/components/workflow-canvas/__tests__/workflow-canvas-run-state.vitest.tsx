/**
 * TASK-1036 F2 — run state is first-class on the canvas: a running node pulses, a lit edge is
 * recoloured through the canvas token, the active edge animates, and a node's run warnings are
 * counted in its chip. Every animation sits behind `prefers-reduced-motion: no-preference`; state
 * is always spelled out as text (rule 11 §10, never colour alone).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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


import type { WorkflowCanvasEdge } from '../types';

function renderGraph(nodes: WorkflowCanvasNode[], edges: WorkflowCanvasEdge[] = []) {
  return render(<WorkflowCanvas nodes={nodes} edges={edges} aria-label="Workflow canvas" />);
}

const A: WorkflowCanvasNode = { id: 'a', type: 'core.agent', label: 'Extract', position: { x: 0, y: 0 } };
const B: WorkflowCanvasNode = { id: 'b', type: 'core.agent', label: 'Summarise', position: { x: 260, y: 0 } };

function chip(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-run-state]');
}
function edgePath(container: HTMLElement): SVGPathElement | null {
  return container.querySelector('.react-flow__edge .react-flow__edge-path');
}

describe('WorkflowCanvas — first-class run state (TASK-1036 F2)', () => {
  it('pulses the running node chip, behind prefers-reduced-motion: no-preference', async () => {
    const { container } = renderGraph([{ ...A, runState: 'running' }]);
    await waitFor(() => expect(chip(container)).not.toBeNull());
    // `motion-safe:` compiles to @media (prefers-reduced-motion: no-preference) — never a bare animate-pulse.
    expect(chip(container)!.className).toContain('motion-safe:animate-pulse');
    expect(chip(container)!.className).not.toMatch(/(^|\s)animate-pulse/);
  });

  it('does not pulse a finished or waiting node', async () => {
    const { container } = renderGraph([{ ...A, runState: 'ok' }]);
    await waitFor(() => expect(chip(container)).not.toBeNull());
    expect(chip(container)!.className).not.toContain('animate-pulse');
  });

  it('spells the run warning count out as text', async () => {
    const { container } = renderGraph([{ ...A, runState: 'ok', runWarnings: 2 }, { ...B, runState: 'ok', runWarnings: 1 }]);
    await waitFor(() => expect(container.querySelectorAll('[data-run-state]').length).toBe(2));
    expect(screen.getByText('2 warnings')).toBeInTheDocument();
    expect(screen.getByText('1 warning')).toBeInTheDocument();
  });

  it('shows no warning text when the count is zero or absent', async () => {
    const { container } = renderGraph([{ ...A, runState: 'ok', runWarnings: 0 }]);
    await waitFor(() => expect(chip(container)).not.toBeNull());
    expect(screen.queryByText(/warning/i)).not.toBeInTheDocument();
  });

  it('recolours a lit edge through the canvas token and animates only the active one', async () => {
    const done = renderGraph([A, B], [{ id: 'e', source: 'a', target: 'b', runState: 'done' }]);
    await waitFor(() => expect(edgePath(done.container)).not.toBeNull());
    expect(edgePath(done.container)!.getAttribute('style')).toContain('--workflow-canvas-edge-done');
    expect(edgePath(done.container)!.getAttribute('class')).not.toContain('workflow-edge-active');
    done.unmount();

    const active = renderGraph([A, B], [{ id: 'e', source: 'a', target: 'b', runState: 'active' }]);
    await waitFor(() => expect(edgePath(active.container)).not.toBeNull());
    expect(edgePath(active.container)!.getAttribute('style')).toContain('--workflow-canvas-edge-active');
    expect(edgePath(active.container)!.getAttribute('class')).toContain('workflow-edge-active');
  });

  it('leaves an idle or run-less edge on the plain edge token', async () => {
    const { container } = renderGraph([A, B], [{ id: 'e', source: 'a', target: 'b', runState: 'idle' }]);
    await waitFor(() => expect(edgePath(container)).not.toBeNull());
    expect(edgePath(container)!.getAttribute('style')).toContain('var(--workflow-canvas-edge)');
    expect(edgePath(container)!.getAttribute('class')).not.toContain('workflow-edge-active');
  });

  it('ships the active-edge animation only inside prefers-reduced-motion: no-preference', () => {
    const css = readFileSync(resolve(__dirname, '../canvas-tokens.css'), 'utf8');
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/g, '');
    expect(css).toContain('workflow-edge-active');
    expect(outside).not.toContain('animation');
  });

  it('has zero axe violations with run state on', async () => {
    const { container } = renderGraph(
      [{ ...A, runState: 'running' }, { ...B, runState: 'ok', runWarnings: 1 }],
      [{ id: 'e', source: 'a', target: 'b', runState: 'active' }],
    );
    await waitFor(() => expect(chip(container)).not.toBeNull());
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
