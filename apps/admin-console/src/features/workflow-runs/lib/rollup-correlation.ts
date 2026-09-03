import type { RunNodeRollup, WorkflowGraphNode } from '../api/types';

/**
 * Best-effort correlation of a run's per-node rollups onto the AUTHORED graph
 * nodes that (most likely) produced them.
 *
 * The trajectory row carries no per-node id (Task 1 contract — the
 * interpreter stamps only the node TYPE onto the persisted step, never the
 * authored node's id) — this is a real, disclosed gap, not something this
 * function can paper over. The correlation below is the closest honest
 * approximation available: for each node `type`, zip the graph's authored
 * nodes of that type (in the order they appear in `graph.nodes`) against the
 * run's rollup groups of that type (already ordered by `order`, i.e. by
 * position in the run's step sequence). When a graph has more than one node
 * of the same type this is NOT guaranteed to be the exact node that ran —
 * callers must treat it as approximate, never as ground truth identity.
 */
export function correlateRollupsToGraphNodes(
  graphNodes: readonly WorkflowGraphNode[],
  rollups: readonly RunNodeRollup[],
): Map<string, RunNodeRollup> {
  const nodeIdsByType = new Map<string, string[]>();
  for (const node of graphNodes) {
    const list = nodeIdsByType.get(node.type) ?? [];
    list.push(node.id);
    nodeIdsByType.set(node.type, list);
  }

  const cursorByType = new Map<string, number>();
  const result = new Map<string, RunNodeRollup>();

  for (const rollup of [...rollups].sort((a, b) => a.order - b.order)) {
    const ids = nodeIdsByType.get(rollup.nodeType);
    if (!ids || ids.length === 0) continue; // a run node type absent from THIS version's graph — no node to attach to
    const cursor = cursorByType.get(rollup.nodeType) ?? 0;
    if (cursor >= ids.length) continue; // more rollup occurrences than authored nodes of this type — leave unmatched rather than guess
    result.set(ids[cursor], rollup);
    cursorByType.set(rollup.nodeType, cursor + 1);
  }

  return result;
}
