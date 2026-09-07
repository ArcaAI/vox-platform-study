/**
 * TASK-893 §3.3 — dragging a node into (or out of) a loop body.
 *
 * `parentId` is already on the wire and the compiler already lifts a group's children into
 * `loops[].body`; only the authoring affordance was missing. The composite contributes the one
 * thing only it can — the geometry: it hit-tests the dragged node's centre against every group's
 * DERIVED extent and re-bases the position onto the new parent's frame, so the consumer stores
 * what it is handed verbatim.
 *
 * happy-dom cannot run a real React Flow pointer drag, so React Flow is replaced with a prop
 * recorder and `onNodeDragStop` is invoked with the node React Flow would hand it. That also
 * bypasses `extent: 'parent'`, which is what lets the "dragged OUT" branch be exercised at all —
 * see the note on that test.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

import { WorkflowCanvas } from '../workflow-canvas';
import type { WorkflowCanvasNode } from '../types';

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

/**
 * `loop` sits at (400, 0) and holds `body` at (24, 56). With React Flow mocked nothing is ever
 * measured, so every node takes the 180x80 fallback and the group's derived extent is
 * width  = max(240, 24 + 180 + 24) = 240  -> x spans [400, 640]
 * height = max(120, 56 +  80 + 24) = 160  -> y spans [  0, 160]
 */
const NODES: WorkflowCanvasNode[] = [
  { id: 'free', type: 'core.agent', label: 'Free node', position: { x: 0, y: 0 } },
  { id: 'loop', type: 'core.loop', label: 'Loop', kind: 'group', position: { x: 400, y: 0 } },
  { id: 'body', type: 'core.agent', label: 'Body', position: { x: 24, y: 56 }, parentId: 'loop' },
];

type DragStop = (event: unknown, node: { id: string; position: { x: number; y: number } }) => void;

function dragStop(): DragStop {
  return (capturedProps.at(-1) as { onNodeDragStop: DragStop }).onNodeDragStop;
}

describe('WorkflowCanvas — re-parenting on drag stop', () => {
  beforeEach(() => {
    capturedProps.length = 0;
  });

  it('reports the new parent and a position already re-based onto it when a node is dropped on a group', () => {
    const onNodeParentChange = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onNodeParentChange={onNodeParentChange} />);

    // Centre lands at (590, 80): inside the loop's [400,640] x [0,160] box.
    dragStop()({}, { id: 'free', position: { x: 500, y: 40 } });

    expect(onNodeParentChange).toHaveBeenCalledTimes(1);
    expect(onNodeParentChange).toHaveBeenCalledWith('free', 'loop', { x: 100, y: 40 });
  });

  it('says nothing when a move keeps the node in the same parent — that is a position change, not a re-parent', () => {
    const onNodeParentChange = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onNodeParentChange={onNodeParentChange} />);

    // Top level -> still top level (centre at (90, 240), outside the loop).
    dragStop()({}, { id: 'free', position: { x: 0, y: 200 } });
    // Inside the loop -> still inside the loop (absolute (424,112), centre (514,152)).
    dragStop()({}, { id: 'body', position: { x: 24, y: 56 } });

    expect(onNodeParentChange).not.toHaveBeenCalled();
  });

  it('reports a null parent and an absolute position when a child leaves its group', () => {
    // Reachable through the store (`unwrapLoop`) and through a keyboard path; NOT through a
    // pointer drag today, because `extent: 'parent'` clamps a child inside its own group. The
    // branch is pinned here so the geometry stays correct for whichever caller reaches it.
    const onNodeParentChange = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onNodeParentChange={onNodeParentChange} />);

    // Relative (-500, 0) against a parent at (400, 0) = absolute (-100, 0); centre (-10, 40).
    dragStop()({}, { id: 'body', position: { x: -500, y: 0 } });

    expect(onNodeParentChange).toHaveBeenCalledTimes(1);
    expect(onNodeParentChange).toHaveBeenCalledWith('body', null, { x: -100, y: 0 });
  });

  it('never re-parents a group — a loop body drags its children with it and must not nest', () => {
    const onNodeParentChange = vi.fn();
    const nested: WorkflowCanvasNode[] = [
      ...NODES,
      { id: 'outer', type: 'core.loop', label: 'Outer', kind: 'group', position: { x: 0, y: 600 } },
    ];
    render(<WorkflowCanvas nodes={nested} edges={[]} aria-label="Workflow canvas" onNodeParentChange={onNodeParentChange} />);

    dragStop()({}, { id: 'loop', position: { x: 20, y: 620 } });

    expect(onNodeParentChange).not.toHaveBeenCalled();
  });

  it('never re-parents on a read-only canvas', () => {
    const onNodeParentChange = vi.fn();
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onNodeParentChange={onNodeParentChange} readOnly />);

    dragStop()({}, { id: 'free', position: { x: 500, y: 40 } });

    expect(onNodeParentChange).not.toHaveBeenCalled();
  });

  it('keeps a child pinned inside its parent with extent: parent', () => {
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" onNodeParentChange={vi.fn()} />);
    const xyNodes = (capturedProps.at(-1) as { nodes: { id: string; parentId?: string; extent?: string }[] }).nodes;
    const body = xyNodes.find((node) => node.id === 'body');
    expect(body?.parentId).toBe('loop');
    expect(body?.extent).toBe('parent');
    expect(xyNodes.find((node) => node.id === 'free')?.extent).toBeUndefined();
  });

  it('is inert when the consumer wired no re-parent handler', () => {
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" />);
    expect(() => dragStop()({}, { id: 'free', position: { x: 500, y: 40 } })).not.toThrow();
  });
});
