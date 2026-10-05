/**
 * TASK-1036 C2b — the composer's canvas CALLBACKS, exercised with the events React Flow would hand
 * the composite (happy-dom cannot drive a real connection drag or an edge click):
 *
 *  - `onEdgeSelect`: selecting an edge opens the edge inspector (§3.6), clearing deselects it;
 *  - `onConnectEndOnPane`: a link dragged out of a handle and dropped on EMPTY canvas reports the
 *    handle and the drop point, so the consumer can open the add-a-step command menu (§8.4 item 7).
 *  - `selectedEdgeId` controls which edge renders as selected.
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
  { id: 'a', type: 'core.agent', label: 'A', position: { x: 0, y: 0 } },
  { id: 'b', type: 'core.agent', label: 'B', position: { x: 260, y: 0 } },
];
const EDGES: WorkflowCanvasEdge[] = [{ id: 'a-b', source: 'a', target: 'b' }];

type Latest = {
  onSelectionChange: (selection: { nodes: unknown[]; edges: Array<{ id: string }> }) => void;
  onConnectEnd: (event: { clientX: number; clientY: number; target?: unknown }, state: Record<string, unknown>) => void;
  edges: Array<{ id: string; selected?: boolean }>;
};
const latest = () => capturedProps.at(-1) as Latest;

describe('WorkflowCanvas — edge selection', () => {
  beforeEach(() => {
    capturedProps.length = 0;
  });

  it('reports the selected edge, and null when the selection holds no edge', () => {
    const onEdgeSelect = vi.fn();
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} onEdgeSelect={onEdgeSelect} />);
    latest().onSelectionChange({ nodes: [], edges: [{ id: 'a-b' }] });
    expect(onEdgeSelect).toHaveBeenLastCalledWith('a-b');
    latest().onSelectionChange({ nodes: [], edges: [] });
    expect(onEdgeSelect).toHaveBeenLastCalledWith(null);
  });

  it('renders the controlled selectedEdgeId as selected', () => {
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} selectedEdgeId="a-b" />);
    expect(latest().edges.find((edge) => edge.id === 'a-b')?.selected).toBe(true);
  });
});

describe('WorkflowCanvas — a link dropped on empty canvas', () => {
  beforeEach(() => {
    capturedProps.length = 0;
  });

  it('reports the handle it came from and where it was dropped', () => {
    const onConnectEndOnPane = vi.fn();
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} onConnectEndOnPane={onConnectEndOnPane} />);
    latest().onConnectEnd({ clientX: 40, clientY: 50 }, { isValid: false, fromNode: { id: 'a' }, fromHandle: { id: 'out:text', type: 'source' }, toNode: null });
    expect(onConnectEndOnPane).toHaveBeenCalledWith({ nodeId: 'a', handleId: 'out:text' }, { x: 40, y: 50 });
  });

  it('stays quiet when the link landed on a node, and from a target handle', () => {
    const onConnectEndOnPane = vi.fn();
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} onConnectEndOnPane={onConnectEndOnPane} />);
    latest().onConnectEnd({ clientX: 1, clientY: 1 }, { isValid: true, fromNode: { id: 'a' }, fromHandle: { id: 'out:text', type: 'source' }, toNode: { id: 'b' } });
    latest().onConnectEnd({ clientX: 1, clientY: 1 }, { isValid: false, fromNode: { id: 'b' }, fromHandle: { id: 'in:x', type: 'target' }, toNode: null });
    expect(onConnectEndOnPane).not.toHaveBeenCalled();
  });

  it('is not wired on a read-only canvas', () => {
    const onConnectEndOnPane = vi.fn();
    render(<WorkflowCanvas aria-label="graph" nodes={NODES} edges={EDGES} onConnectEndOnPane={onConnectEndOnPane} readOnly />);
    latest().onConnectEnd?.({ clientX: 1, clientY: 1 }, { isValid: false, fromNode: { id: 'a' }, fromHandle: { id: 'out', type: 'source' }, toNode: null });
    expect(onConnectEndOnPane).not.toHaveBeenCalled();
  });
});
