import type { WorkflowGraph } from '@arcaai/workflow-contract';

/**
 * TASK-1036 owner directive W1 — a new workflow opens with its two boundary nodes already placed
 * and connected: `core.trigger` (the entry point) and `core.output` (the exit). Neither can be
 * deleted afterwards, so the server seeds both when `create` receives a graph with no nodes at
 * all (the Studio's "New" button posts one).
 *
 * The configs are the MINIMUM that passes SHAPE validation (`node-config-schemas.ts`):
 *  - `core.trigger` requires `kinds` (1..4 of consultation | api | webhook | schedule) -> `['api']`;
 *  - `core.output` requires nothing; `protocols` is written out at its schema default so the stored
 *    graph says what it means.
 * The `core.trigger.next -> core.output.after` edge is the control (ordering) edge both nodes
 * declare in `node-ports.ts`; it connects the boundaries without inventing a data wire.
 *
 * A graph that has ANY node or edge, or is malformed, is returned UNCHANGED (same reference): this is
 * a seed for blank graphs, never a repair of authored ones.
 */
export const SEEDED_TRIGGER_NODE_ID = 'start';
export const SEEDED_OUTPUT_NODE_ID = 'end';

export function seedBoundaryNodes(graph: WorkflowGraph): WorkflowGraph {
  // Blank means `nodes: []` AND `edges: []`. A graph missing `edges` is MALFORMED, not blank, and
  // must still fail the shape gate rather than be papered over by a seed.
  if (!Array.isArray(graph.nodes) || graph.nodes.length > 0) return graph;
  if (!Array.isArray(graph.edges) || graph.edges.length > 0) return graph;
  return {
    version: 1,
    nodes: [
      { id: SEEDED_TRIGGER_NODE_ID, type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 80, y: 80 } },
      { id: SEEDED_OUTPUT_NODE_ID, type: 'core.output', config: { protocols: ['http-sse'] }, position: { x: 80, y: 320 } },
    ],
    edges: [{ id: 'start_to_end', from: SEEDED_TRIGGER_NODE_ID, fromPort: 'next', to: SEEDED_OUTPUT_NODE_ID, toPort: 'after' }],
  };
}
