/**
 * TASK-1036 review R-C — the canvas inside the Studio:
 *
 *  #1 `viewportInsets` (the docked panes' footprint) moves the zoom controls and the minimap clear
 *     of the panes, so keyboard focus on Zoom never lands under a pane (and never makes it yield).
 *  #2 `fitView` fits into the FREE rectangle: per-side pixel padding grown by the insets, on the
 *     initial fit, the re-fit and the Controls' own fit button.
 *  #8 a typed port SAYS its type (a visible suffix), and the list colour is the strong token (3:1).
 *  #9 `wheelZoom="modifier"` (the default for a read-only canvas): the wheel scrolls the page and
 *     Ctrl/⌘+wheel zooms, and the canvas says so.
 *  #10 the run chip speaks the spec's words: Waiting / Running / Done / Failed / Skipped.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

const flowProps: Array<Record<string, unknown>> = [];
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  const Recorded = (props: Record<string, unknown>) => {
    flowProps.push(props);
    return React.createElement(actual.ReactFlow as unknown as React.ComponentType<Record<string, unknown>>, props);
  };
  return { ...actual, ReactFlow: Recorded };
});

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasNode, WorkflowCanvasRunState } from '../types';

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

beforeEach(() => {
  flowProps.length = 0;
});

const lastFlow = () => flowProps.at(-1) as Record<string, unknown> & { fitViewOptions?: { padding?: unknown } };

const A: WorkflowCanvasNode = { id: 'a', type: 'core.agent', label: 'Extract', position: { x: 0, y: 0 } };
const B: WorkflowCanvasNode = { id: 'b', type: 'core.agent', label: 'Summarise', position: { x: 260, y: 0 } };

describe('WorkflowCanvas — insets keep the chrome clear of the panes (R-C #1, #2)', () => {
  it('moves the zoom controls and the minimap in by the panes’ footprint', async () => {
    const { container } = render(<WorkflowCanvas nodes={[A, B]} edges={[]} aria-label="Graph" viewportInsets={{ left: 272, right: 372 }} />);
    await waitFor(() => expect(container.querySelector('.react-flow__controls')).not.toBeNull());
    const controls = container.querySelector('.react-flow__controls') as HTMLElement;
    const minimap = container.querySelector('.react-flow__minimap') as HTMLElement;
    expect(controls.style.marginLeft).toBe('287px');
    expect(minimap.style.marginRight).toBe('387px');
  });

  it('fits into the free rectangle: per-side pixel padding grown by the insets', () => {
    render(<WorkflowCanvas nodes={[A, B]} edges={[]} aria-label="Graph" viewportInsets={{ left: 272, right: 372 }} />);
    const padding = lastFlow().fitViewOptions?.padding as Record<string, string>;
    expect(padding.left).toBe(`${272 + 56}px`);
    expect(padding.right).toBe(`${372 + 32}px`);
    expect(padding.top).toBe('56px');
    expect(padding.bottom).toBe('32px');
  });

  it('keeps the old proportional padding when no insets are given', () => {
    render(<WorkflowCanvas nodes={[A, B]} edges={[]} aria-label="Graph" />);
    expect(lastFlow().fitViewOptions?.padding).toBe(0.2);
  });
});

describe('WorkflowCanvas — wheel zoom on a read-only canvas (R-C #9)', () => {
  it('a read-only canvas lets the wheel scroll the page and zooms on Ctrl/⌘+wheel', () => {
    render(<WorkflowCanvas nodes={[A]} edges={[]} readOnly aria-label="Run flow" />);
    expect(lastFlow().zoomOnScroll).toBe(false);
    expect(lastFlow().preventScrolling).toBe(false);
    expect(lastFlow().zoomOnPinch).toBe(true);
    expect(screen.getByText(/Ctrl.*scroll to zoom/i)).toBeInTheDocument();
  });

  it('an editable canvas keeps wheel zoom', () => {
    render(<WorkflowCanvas nodes={[A]} edges={[]} aria-label="Graph" />);
    expect(lastFlow().zoomOnScroll).not.toBe(false);
    expect(screen.queryByText(/Ctrl.*scroll to zoom/i)).toBeNull();
  });

  it('`wheelZoom="scroll"` keeps wheel zoom on a read-only canvas that fills its region', () => {
    render(<WorkflowCanvas nodes={[A]} edges={[]} readOnly wheelZoom="scroll" aria-label="Graph" />);
    expect(lastFlow().zoomOnScroll).not.toBe(false);
  });
});

describe('WorkflowCanvas — run chip copy (R-C #10)', () => {
  const COPY: Array<[WorkflowCanvasRunState, string]> = [
    ['pending', 'Waiting'],
    ['running', 'Running'],
    ['ok', 'Done'],
    ['failed', 'Failed'],
    ['skipped', 'Skipped'],
  ];
  it.each(COPY)('%s reads “%s”', async (state, label) => {
    const { container } = render(<WorkflowCanvas nodes={[{ ...A, runState: state }]} edges={[]} aria-label="Graph" />);
    await waitFor(() => expect(container.querySelector('[data-run-state]')).not.toBeNull());
    expect(container.querySelector('[data-run-state]')!.textContent).toContain(label);
  });
});

describe('WorkflowCanvas — typed ports say their type (R-C #8)', () => {
  const PORTED: WorkflowCanvasNode = {
    ...A,
    inputPorts: [{ id: 'in:message', label: 'message', type: 'text', tone: 'text', required: true }],
    outputPorts: [
      { id: 'out:count', label: 'count', type: 'number', tone: 'number' },
      { id: 'out:entities', label: 'entities', type: 'list<entity>', tone: 'list' },
    ],
  };

  it('shows a short visible type suffix beside each port', async () => {
    const { container } = render(<WorkflowCanvas nodes={[PORTED]} edges={[]} aria-label="Graph" />);
    await waitFor(() => expect(container.querySelector('[data-slot="workflow-port-type"]')).not.toBeNull());
    const suffixes = [...container.querySelectorAll('[data-slot="workflow-port-type"]')].map((element) => element.textContent);
    expect(suffixes).toEqual(['text', 'num', 'list']);
  });

  it('draws a list port in the strong warning token (≥ 3:1), not the base one', () => {
    const css = readFileSync(resolve(__dirname, '../canvas-tokens.css'), 'utf8');
    expect(css).toMatch(/--workflow-canvas-port-list:\s*var\(--warning-strong/);
  });

  it('0 axe violations with ports, a run chip and insets', async () => {
    const { container } = render(<WorkflowCanvas nodes={[{ ...PORTED, runState: 'ok' }]} edges={[]} aria-label="Graph" viewportInsets={{ left: 100 }} />);
    await waitFor(() => expect(container.querySelector('[data-run-state]')).not.toBeNull());
    expect(await axe(container)).toHaveNoViolations();
  });
});
