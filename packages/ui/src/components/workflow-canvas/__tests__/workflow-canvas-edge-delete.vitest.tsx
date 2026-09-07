/**
 * TASK-893 §2.2 — deleting a connection, the change channel.
 *
 * Before this ticket the composite's edge-change handler opened with `if (!onEdgesChange) return;`
 * and the Studio never passed `onEdgesChange`, so EVERY edge `remove` change — the Delete key on a
 * selected edge included — was dropped on the floor, and the only way to remove a connection was
 * the List view the redesign deletes. `onEdgeDelete` is now the one deletion channel, fed by both
 * the key and a hover-X on the edge, exactly as node removal is fed by both the key and the node's
 * own X.
 *
 * React Flow is replaced with a prop recorder here: happy-dom cannot run a real key-driven edge
 * deletion, so the handler is exercised with the `EdgeChange` React Flow would hand it. The
 * pointer/keyboard affordance itself is covered in `workflow-canvas-edge-affordance.vitest.tsx`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasEdge, WorkflowCanvasNode } from '../types';

const capturedProps: Record<string, unknown>[] = [];
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown>) => {
      capturedProps.push(props);
      return null;
    },
  };
});

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const NODES: WorkflowCanvasNode[] = [
  { id: 'ingest', type: 'stt.ingest', label: 'Ingest audio', position: { x: 0, y: 0 } },
  { id: 'summarize', type: 'text.summarize', label: 'Summarize', position: { x: 260, y: 0 } },
];
const EDGES: WorkflowCanvasEdge[] = [{ id: 'ingest-summarize', source: 'ingest', target: 'summarize' }];

function latest() {
  return capturedProps.at(-1) as {
    onEdgesChange: (changes: Record<string, unknown>[]) => void;
    deleteKeyCode: unknown;
  };
}

describe('WorkflowCanvas — edge deletion through onEdgeDelete', () => {
  beforeEach(() => {
    capturedProps.length = 0;
  });

  it('turns a `remove` edge change into exactly one onEdgeDelete call, by id', () => {
    const onEdgeDelete = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={onEdgeDelete} />);

    latest().onEdgesChange([{ id: 'ingest-summarize', type: 'remove' }]);

    expect(onEdgeDelete).toHaveBeenCalledTimes(1);
    expect(onEdgeDelete).toHaveBeenCalledWith('ingest-summarize');
  });

  it('never rewrites the edge array for a removal — removal is reported by id, like onDeleteRequest', () => {
    const onEdgeDelete = vi.fn();
    const onEdgesChange = vi.fn();
    render(
      <WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={onEdgeDelete} onEdgesChange={onEdgesChange} />,
    );

    latest().onEdgesChange([{ id: 'ingest-summarize', type: 'remove' }]);

    expect(onEdgeDelete).toHaveBeenCalledWith('ingest-summarize');
    expect(onEdgesChange).not.toHaveBeenCalled();
  });

  it('still forwards non-removal edge changes to onEdgesChange', () => {
    const onEdgesChange = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgesChange={onEdgesChange} />);

    latest().onEdgesChange([{ id: 'ingest-summarize', type: 'select', selected: true }]);

    expect(onEdgesChange).toHaveBeenCalledTimes(1);
    expect(onEdgesChange.mock.calls[0][0]).toEqual([
      { id: 'ingest-summarize', source: 'ingest', target: 'summarize', sourceHandle: undefined, targetHandle: undefined, label: undefined },
    ]);
  });

  it('keeps the delete key armed for edges on an editable canvas and disarmed when read-only', () => {
    const { rerender } = render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} />);
    expect(latest().deleteKeyCode).toEqual(['Backspace', 'Delete']);

    rerender(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} readOnly />);
    expect(latest().deleteKeyCode).toBeNull();
  });

  it('drops a removal silently when the consumer wired no deletion channel', () => {
    const onEdgesChange = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgesChange={onEdgesChange} />);
    expect(() => latest().onEdgesChange([{ id: 'ingest-summarize', type: 'remove' }])).not.toThrow();
    expect(onEdgesChange).not.toHaveBeenCalled();
  });
});
