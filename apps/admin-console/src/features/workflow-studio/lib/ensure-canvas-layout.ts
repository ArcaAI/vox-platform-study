/**
 * Seeded and pre-Studio graphs omit `position`, so `fromWorkflowGraph` places every
 * node at `{ x: 0, y: 0 }`. React Flow then stacks them on the same point — they look
 * glued together, a drag grabs the pile, and Auto layout looks like a no-op because
 * `fitView` already zoomed into the origin. The run-trace canvas already lays a missing
 * position out (`workflow-runs/lib/graph-layout.ts`); this is the same fallback for the
 * authoring canvas.
 */
import { layoutWorkflowGraph } from '@arcaai/ui/components/workflow-canvas';
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';

const LOOP_NODE_TYPE = 'core.loop';

export function positionsAreClustered(nodes: readonly { position: { x: number; y: number } }[]): boolean {
  if (nodes.length < 2) return false;
  const { x, y } = nodes[0].position;
  return nodes.every((node) => node.position.x === x && node.position.y === y);
}

/** Layered positions when every node shares a point; `null` when the graph already has a layout. */
export async function layoutClusteredGraph(
  nodes: readonly GraphStoreNode[],
  edges: readonly GraphStoreEdge[],
): Promise<Record<string, { x: number; y: number }> | null> {
  if (!positionsAreClustered(nodes)) return null;
  const result = await layoutWorkflowGraph(
    nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      kind: node.type === LOOP_NODE_TYPE ? ('group' as const) : ('node' as const),
    })),
    edges.map((edge) => ({ source: edge.source, target: edge.target })),
  );
  return result.positions;
}
