/**
 * TASK-965 — `WorkflowCanvasEdge.kind: 'binding'`.
 *
 * A binding is a data input the consumer edits in its own inspector field (the Studio's
 * "secondary inputs", TASK-893 §3.1). Before this, such an edge was simply not handed to the
 * canvas, so the platform's own default workflow — trigger `out` bound into the agent's `context`
 * — rendered as a trigger connected to nothing while the footer counted the connection. A binding
 * edge is now drawn (dashed, labelled) but never deletable from the canvas.
 *
 * React Flow is replaced with a prop recorder, as in the edge-delete suite.
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
  { id: 'n_trigger', type: 'core.trigger', label: 'Trigger', position: { x: 0, y: 0 } },
  { id: 'n_summary', type: 'core.agent', label: 'Summary', position: { x: 260, y: 0 } },
];
const EDGES: WorkflowCanvasEdge[] = [
  { id: 'e1', source: 'n_trigger', target: 'n_summary', sourceHandle: 'out', targetHandle: 'in', label: 'context', kind: 'binding' },
  { id: 'e2', source: 'n_summary', target: 'n_trigger', sourceHandle: 'out', targetHandle: 'in' },
];

function latestEdges() {
  return (capturedProps.at(-1) as { edges: { id: string; deletable?: boolean; data?: { kind?: string }; label?: unknown }[] }).edges;
}

describe('WorkflowCanvas — binding edges', () => {
  beforeEach(() => {
    capturedProps.length = 0;
  });

  it('hands a binding edge to React Flow as non-deletable, keeping its label and kind', () => {
    render(<WorkflowCanvas nodes={NODES} edges={EDGES} aria-label="Workflow canvas" onEdgeDelete={vi.fn()} />);

    const [binding, wire] = latestEdges();
    expect(binding.id).toBe('e1');
    expect(binding.deletable).toBe(false);
    expect(binding.data?.kind).toBe('binding');
    expect(binding.label).toBe('context');
    // An ordinary wire on the same canvas is still deletable.
    expect(wire.deletable).toBe(true);
    expect(wire.data?.kind).toBe('wire');
  });
});
