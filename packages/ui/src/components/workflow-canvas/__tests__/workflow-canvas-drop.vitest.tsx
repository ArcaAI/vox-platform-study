/**
 * TASK-890 black-box J4-F1 — drop-to-add on the canvas pane.
 *
 * The palette item promised a drag ("drag-from-palette is an enhancement layered on top by the
 * canvas composite") that no code implemented: no `draggable`, no drop target. The composite's
 * half is the projection — it turns a screen point into a flow point (`screenToFlowPosition`,
 * so pan/zoom are honoured) and hands the raw event on; deciding what the payload MEANS stays
 * with the consumer, which is the only side that knows the node registry.
 *
 * The pointer-free path is untouched: the palette's `<button>` still adds a node on click, so
 * dragging is an enhancement, never the only way in (WCAG 2.5.7).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasNode } from '../types';

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { width: 400, height: 300, top: 20, left: 10, right: 410, bottom: 320, x: 10, y: 20, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const NODES: WorkflowCanvasNode[] = [{ id: 'ingest', type: 'stt.ingest', label: 'Ingest audio', position: { x: 0, y: 0 } }];

/**
 * happy-dom builds the dispatched event its OWN `DataTransfer` (the items are copied across, the
 * object identity is not), so an assertion has to read what the HANDLER saw — never this object's
 * `dropEffect` afterwards. `defaultPrevented` is the load-bearing half anyway: a `dragover` that
 * is not prevented means the browser never treats the pane as a drop target at all.
 */
function dataTransfer(entries: Record<string, string> = {}): DataTransfer {
  const transfer = new DataTransfer();
  for (const [format, value] of Object.entries(entries)) transfer.setData(format, value);
  return transfer;
}

describe('WorkflowCanvas — drop-to-add', () => {
  it('reports a drop on the pane with a flow position and the original event', () => {
    const onPaneDrop = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onPaneDrop={onPaneDrop} />);

    const pane = document.querySelector('[data-slot="workflow-canvas"]') as HTMLElement;
    fireEvent.drop(pane, { dataTransfer: dataTransfer({ 'application/x-hope-workflow-node': 'core.agent' }), clientX: 210, clientY: 170 });

    expect(onPaneDrop).toHaveBeenCalledTimes(1);
    const [event, position] = onPaneDrop.mock.calls[0] as [{ dataTransfer: DataTransfer }, { x: number; y: number }];
    expect(event.dataTransfer.getData('application/x-hope-workflow-node')).toBe('core.agent');
    expect(typeof position.x).toBe('number');
    expect(typeof position.y).toBe('number');
  });

  it('accepts the drag only while a drop handler is wired and the canvas is editable', () => {
    const onPaneDrop = vi.fn();
    const { rerender } = render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onPaneDrop={onPaneDrop} />);
    const pane = document.querySelector('[data-slot="workflow-canvas"]') as HTMLElement;

    // `false` = the event was default-prevented, i.e. the pane accepted the drag.
    expect(fireEvent.dragOver(pane, { dataTransfer: dataTransfer() })).toBe(false);

    rerender(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onPaneDrop={onPaneDrop} readOnly />);
    expect(fireEvent.dragOver(pane, { dataTransfer: dataTransfer() })).toBe(true);
  });

  it('never reports a drop on a read-only canvas', () => {
    const onPaneDrop = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onPaneDrop={onPaneDrop} readOnly />);

    fireEvent.drop(document.querySelector('[data-slot="workflow-canvas"]') as HTMLElement, { dataTransfer: dataTransfer(), clientX: 60, clientY: 60 });

    expect(onPaneDrop).not.toHaveBeenCalled();
  });

  it('keeps the pointer-free hint — dragging is an enhancement, not the only path', () => {
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onPaneDrop={vi.fn()} />);
    expect(screen.getByText(/removes it without a drag/i)).toBeTruthy();
  });
});
