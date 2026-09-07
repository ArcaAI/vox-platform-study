/**
 * TASK-890 black-box J5-F2 — a drag must not be a selection.
 *
 * `selected` is a CONTROLLED prop here: `toXyNode` derives it from the consumer's
 * `selectedNodeId` on every sync. React Flow's default `selectNodesOnDrag` selects a node the
 * moment a drag starts, so with an unselected node the two disagreed and fought: React Flow set
 * `selected` true, the next prop sync set it false, `onSelectionChange` re-announced, and the
 * cycle repeated until React gave up with "Maximum update depth exceeded" — the editor's error
 * boundary swallowed the whole graph mid-drag ("This definition failed to load") and the move was
 * lost. Dragging a node that was ALREADY selected never crashed, which is what named the cause.
 *
 * Selection stays one-way (React Flow -> `onSelectionChange` -> `onSelect` -> consumer store), so
 * pointing at a node still selects it; only the drag no longer does it behind the prop's back.
 *
 * jsdom/happy-dom cannot run a real React Flow pointer drag, so this reads the prop the fix turns
 * off rather than the interaction — the black-box repro lives in the ticket.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
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

const NODES: WorkflowCanvasNode[] = [{ id: 'ingest', type: 'stt.ingest', label: 'Ingest audio', position: { x: 0, y: 0 } }];

describe('WorkflowCanvas — dragging a node does not change the selection', () => {
  it('turns React Flow selection-on-drag off, so the controlled `selected` prop is never contradicted', () => {
    capturedProps.length = 0;
    render(<WorkflowCanvas nodes={NODES} edges={[]} aria-label="Workflow canvas" />);
    expect(capturedProps.length).toBeGreaterThan(0);
    expect(capturedProps[0].selectNodesOnDrag).toBe(false);
  });
});
